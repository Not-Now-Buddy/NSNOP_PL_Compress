const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { pipeline } = require('stream/promises');

const app = express();
app.use(express.json({ limit: '2mb' }));

const API_KEY = process.env.API_KEY;
const TARGET_MAX_BYTES = 25 * 1024 * 1024;

// Account B (Drive storage account) OAuth config - used for BOTH
// downloading the source file and uploading the compressed result, so
// all Drive storage is attributed to Account B, not Account A.
const DRIVE_B_CLIENT_ID = process.env.DRIVE_B_CLIENT_ID;
const DRIVE_B_CLIENT_SECRET = process.env.DRIVE_B_CLIENT_SECRET;
const DRIVE_B_REFRESH_TOKEN = process.env.DRIVE_B_REFRESH_TOKEN;
const DRIVE_B_OUTPUT_FOLDER_ID = process.env.DRIVE_B_OUTPUT_FOLDER_ID;

// -----------------------------------------------------------------------
// Pulls a readable reason out of a Google API error response so failures
// say WHICH quota/permission/config problem occurred, not just a generic
// "failed" message. Google error bodies typically look like:
// { error: { code, message, status, errors: [{ domain, reason, message }] } }
// -----------------------------------------------------------------------
function extractGoogleErrorReason(errJson) {
  try {
    var err = errJson && errJson.error;
    if (!err) return { reason: 'unknown', message: JSON.stringify(errJson) };
    var firstDetail = (err.errors && err.errors[0]) || {};
    return {
      httpCode: err.code || null,
      status: err.status || null,
      reason: firstDetail.reason || err.status || 'unknown',
      domain: firstDetail.domain || null,
      message: err.message || firstDetail.message || 'No message provided'
    };
  } catch (e) {
    return { reason: 'unparseable', message: String(errJson) };
  }
}

function failStep(res, httpStatus, step, api, rawErrJson, extra) {
  var reason = extractGoogleErrorReason(rawErrJson);
  var body = Object.assign({
    success: false,
    step: step,          // which stage of the pipeline failed
    api: api,             // which Google API endpoint was being called
    googleReason: reason, // parsed { reason, domain, message, httpCode, status }
    rawError: rawErrJson
  }, extra || {});
  return res.status(httpStatus).json(body);
}

// -----------------------------------------------------------------------
// Account B access token, refreshed from the long-lived refresh token.
// Access tokens expire in ~1hr, so cache and refresh a bit early rather
// than on every single request.
// -----------------------------------------------------------------------
let cachedAccessToken = null;
let cachedAccessTokenExpiresAt = 0;

async function getAccountBAccessToken() {
  const now = Date.now();
  if (cachedAccessToken && now < cachedAccessTokenExpiresAt - 60000) {
    return cachedAccessToken;
  }

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: DRIVE_B_CLIENT_ID,
      client_secret: DRIVE_B_CLIENT_SECRET,
      refresh_token: DRIVE_B_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });

  const data = await resp.json();
  if (!data.access_token) {
    var err = new Error(`Failed to refresh Account B access token: ${JSON.stringify(data)}`);
    err.step = 'TOKEN_REFRESH';
    err.api = 'oauth2.googleapis.com/token';
    err.rawError = data;
    throw err;
  }

  cachedAccessToken = data.access_token;
  cachedAccessTokenExpiresAt = now + (data.expires_in ? data.expires_in * 1000 : 3300000);
  return cachedAccessToken;
}

function runGhostscript(inputPath, outputPath, settingLevel) {
  return new Promise((resolve, reject) => {
    execFile('gs', [
      '-sDEVICE=pdfwrite',
      `-dPDFSETTINGS=/${settingLevel}`, // "ebook" = good quality/size balance, "screen" = more aggressive
      '-dCompatibilityLevel=1.4',
      '-dNOPAUSE', '-dBATCH', '-dQUIET',
      `-sOutputFile=${outputPath}`,
      inputPath
    ], { timeout: 8 * 60 * 1000 }, (err) => {
      if (err) return reject(new Error(`Ghostscript failed (${settingLevel}): ${err.message}`));
      resolve();
    });
  });
}

// -----------------------------------------------------------------------
// Diagnostic: confirms exactly which Google account the stored refresh
// token authenticates as, and how much of that account's storage is used.
// Hit this any time there's doubt about which Drive account is in play.
// -----------------------------------------------------------------------
app.get('/whoami', async (req, res) => {
  try {
    if (!API_KEY || req.header('X-Api-Key') !== API_KEY) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    let accessToken;
    try {
      accessToken = await getAccountBAccessToken();
    } catch (e) {
      return failStep(res, 502, e.step || 'TOKEN_REFRESH', e.api || 'oauth2.googleapis.com/token', e.rawError || { error: { message: e.message } });
    }

    const aboutResp = await fetch(
      'https://www.googleapis.com/drive/v3/about?fields=user,storageQuota',
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const aboutJson = await aboutResp.json();

    if (!aboutResp.ok) {
      return failStep(res, aboutResp.status, 'WHOAMI_LOOKUP', 'drive.googleapis.com/about', aboutJson);
    }

    return res.json({
      success: true,
      authenticatedAs: aboutJson.user ? aboutJson.user.emailAddress : 'unknown',
      storageQuota: aboutJson.storageQuota
        ? {
            limitBytes: aboutJson.storageQuota.limit,
            usedBytes: aboutJson.storageQuota.usage,
            usedInDriveBytes: aboutJson.storageQuota.usageInDrive
          }
        : null
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

app.post('/compress', async (req, res) => {
  let workDir;
  try {
    if (!API_KEY || req.header('X-Api-Key') !== API_KEY) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { fileId } = req.body || {};
    if (!fileId) {
      return res.status(400).json({ success: false, error: 'fileId is required' });
    }

    let accessToken;
    try {
      accessToken = await getAccountBAccessToken();
    } catch (e) {
      return failStep(res, 502, e.step || 'TOKEN_REFRESH', e.api || 'oauth2.googleapis.com/token', e.rawError || { error: { message: e.message } });
    }

    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-'));
    const inputPath = path.join(workDir, 'input.pdf');
    const outputPath = path.join(workDir, 'output.pdf');

    // -----------------------------------------------------------------
    // 1. Download the source file, authenticated as Account B (which
    //    must have been shared Viewer access to the source folders).
    // -----------------------------------------------------------------
    const driveResp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!driveResp.ok) {
      let errJson;
      try { errJson = JSON.parse(await driveResp.text()); } catch (e) { errJson = { error: { message: 'Non-JSON response from Drive download' } }; }
      return failStep(res, 502, 'DOWNLOAD_FROM_DRIVE', 'drive.googleapis.com/files.get (alt=media)', errJson, { fileId: fileId });
    }
    await pipeline(driveResp.body, fs.createWriteStream(inputPath));

    const originalSize = fs.statSync(inputPath).size;

    // -----------------------------------------------------------------
    // 2. Compress with Ghostscript. Try "ebook" first (good balance),
    //    fall back to "screen" (more aggressive) if still too big.
    // -----------------------------------------------------------------
    try {
      await runGhostscript(inputPath, outputPath, 'ebook');
    } catch (e) {
      return failStep(res, 500, 'GHOSTSCRIPT_COMPRESS_EBOOK', 'local: ghostscript binary', { error: { message: e.message } });
    }
    let compressedSize = fs.statSync(outputPath).size;

    if (compressedSize > TARGET_MAX_BYTES) {
      try {
        await runGhostscript(inputPath, outputPath, 'screen');
      } catch (e) {
        return failStep(res, 500, 'GHOSTSCRIPT_COMPRESS_SCREEN', 'local: ghostscript binary', { error: { message: e.message } });
      }
      compressedSize = fs.statSync(outputPath).size;
    }

    if (compressedSize > TARGET_MAX_BYTES) {
      return res.json({
        success: false,
        step: 'COMPRESSION_INSUFFICIENT',
        error: `Still ${(compressedSize / 1024 / 1024).toFixed(2)}MB after maximum compression`,
        originalSizeBytes: originalSize,
        compressedSizeBytes: compressedSize
      });
    }

    // -----------------------------------------------------------------
    // 3. Look up the original file's name (for naming the compressed copy).
    // -----------------------------------------------------------------
    const metaResp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?fields=name`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const metaJson = await metaResp.json();
    if (!metaResp.ok) {
      return failStep(res, 502, 'FETCH_SOURCE_METADATA', 'drive.googleapis.com/files.get (fields=name)', metaJson, { fileId: fileId });
    }
    const baseName = (metaJson.name || 'file').replace(/\.pdf$/i, '');

    // -----------------------------------------------------------------
    // 4. Upload the compressed copy into Account B's fixed output
    //    folder - Account B owns this file, so it counts against
    //    Account B's quota, not Account A's.
    // -----------------------------------------------------------------
    const metadata = {
      name: `${baseName}_compressed.pdf`,
      parents: [DRIVE_B_OUTPUT_FOLDER_ID]
    };

    const boundary = 'gcbridgeboundary';
    const outputBytes = fs.readFileSync(outputPath);
    const multipartBody = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
        `${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`
      ),
      outputBytes,
      Buffer.from(`\r\n--${boundary}--`)
    ]);

    const uploadResp = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,size',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': `multipart/related; boundary=${boundary}`
        },
        body: multipartBody
      }
    );
    const uploadJson = await uploadResp.json();
    if (!uploadResp.ok || !uploadJson.id) {
      return failStep(res, 502, 'UPLOAD_COMPRESSED_FILE', 'drive.googleapis.com/files.create (upload)', uploadJson, {
        compressedSizeBytes: compressedSize,
        targetFolderId: DRIVE_B_OUTPUT_FOLDER_ID
      });
    }

    return res.json({
      success: true,
      compressedFileId: uploadJson.id,
      originalSizeBytes: originalSize,
      compressedSizeBytes: compressedSize
    });

  } catch (err) {
    return res.status(500).json({ success: false, step: 'UNCAUGHT_EXCEPTION', error: err.message || String(err) });
  } finally {
    if (workDir) {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
    }
  }
});

app.get('/', (req, res) => res.send('PDF compression bridge is running.'));

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Listening on port ${port}`));
