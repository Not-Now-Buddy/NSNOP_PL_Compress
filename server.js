const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { pipeline } = require('stream/promises');

const app = express();
app.use(express.json({ limit: '2mb' })); // request body is just JSON metadata, always tiny

const API_KEY = process.env.API_KEY;          // shared secret - set at deploy time
const TARGET_MAX_BYTES = 25 * 1024 * 1024;     // Gmail's per-email attachment cap

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

app.post('/compress', async (req, res) => {
  let workDir;
  try {
    if (!API_KEY || req.header('X-Api-Key') !== API_KEY) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { fileId, oauthToken } = req.body || {};
    if (!fileId || !oauthToken) {
      return res.status(400).json({ success: false, error: 'fileId and oauthToken are required' });
    }

    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-'));
    const inputPath = path.join(workDir, 'input.pdf');
    const outputPath = path.join(workDir, 'output.pdf');

    // -----------------------------------------------------------------
    // 1. Download directly from Drive - streamed to disk. Cloud Run has
    //    no ~50MB ceiling the way Apps Script's UrlFetchApp does, so
    //    this works fine for files well past that size.
    // -----------------------------------------------------------------
    const driveResp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      { headers: { Authorization: `Bearer ${oauthToken}` } }
    );
    if (!driveResp.ok) {
      const errText = await driveResp.text();
      return res.status(502).json({ success: false, error: `Drive download failed: ${driveResp.status} ${errText}` });
    }
    await pipeline(driveResp.body, fs.createWriteStream(inputPath));

    const originalSize = fs.statSync(inputPath).size;

    // -----------------------------------------------------------------
    // 2. Compress with Ghostscript. Try "ebook" first (good balance),
    //    fall back to "screen" (more aggressive) if still too big.
    // -----------------------------------------------------------------
    await runGhostscript(inputPath, outputPath, 'ebook');
    let compressedSize = fs.statSync(outputPath).size;

    if (compressedSize > TARGET_MAX_BYTES) {
      await runGhostscript(inputPath, outputPath, 'screen');
      compressedSize = fs.statSync(outputPath).size;
    }

    if (compressedSize > TARGET_MAX_BYTES) {
      return res.json({
        success: false,
        error: `Still ${(compressedSize / 1024 / 1024).toFixed(2)}MB after maximum compression`,
        originalSizeBytes: originalSize,
        compressedSizeBytes: compressedSize
      });
    }

    // -----------------------------------------------------------------
    // 3. Upload the compressed copy back to Drive, in the same parent
    //    folder as the original, named "<original>_compressed.pdf".
    // -----------------------------------------------------------------
    const metaResp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?fields=parents,name`,
      { headers: { Authorization: `Bearer ${oauthToken}` } }
    );
    const metaJson = await metaResp.json();
    const baseName = (metaJson.name || 'file').replace(/\.pdf$/i, '');

    const metadata = {
      name: `${baseName}_compressed.pdf`,
      parents: metaJson.parents || undefined
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
          Authorization: `Bearer ${oauthToken}`,
          'Content-Type': `multipart/related; boundary=${boundary}`
        },
        body: multipartBody
      }
    );
    const uploadJson = await uploadResp.json();
    if (!uploadResp.ok || !uploadJson.id) {
      return res.status(502).json({ success: false, error: `Drive upload failed: ${JSON.stringify(uploadJson)}` });
    }

    return res.json({
      success: true,
      compressedFileId: uploadJson.id,
      originalSizeBytes: originalSize,
      compressedSizeBytes: compressedSize
    });

  } catch (err) {
    return res.status(500).json({ success: false, error: err.message || String(err) });
  } finally {
    if (workDir) {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
    }
  }
});

app.get('/', (req, res) => res.send('PDF compression bridge is running.'));

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Listening on port ${port}`));
