# Deploying the PDF Compression Bridge on Render (free tier, no card)

This is the same service as before (Node + Express + Ghostscript in a
Docker container) - just deployed on Render.com instead of Cloud Run,
since Render's free tier doesn't ask for a credit card at signup.

## What you're deploying
- `server.js` - the bridge itself
- `package.json` - dependencies
- `Dockerfile` - installs Ghostscript alongside Node

None of these need editing for Render - it builds the Dockerfile as-is
and automatically sets the `PORT` environment variable, which `server.js`
already reads (`process.env.PORT || 8080`).

## Step 1: Put the files in a GitHub repo
Render deploys from a Git repo, not direct file upload.

1. Go to github.com, sign in (or create a free account).
2. Click **+ → New repository**. Name it `pdf-compress-bridge`. Public
   or Private both work. Click **Create repository**.
3. On the repo page: **Add file → Upload files** → drag in `server.js`,
   `package.json`, and `Dockerfile` together → **Commit changes**.

## Step 2: Sign up for Render
1. Go to render.com → **Get Started** → sign up with GitHub (this lets
   Render see your repos without extra setup).
2. No payment details required.

## Step 3: Create the web service
1. From the Render dashboard: **New + → Web Service**.
2. Connect the `pdf-compress-bridge` repo.
3. Render auto-detects the `Dockerfile` and picks "Docker" as the
   environment - leave that as-is.
4. Under **Instance Type**, choose **Free**.
5. Under **Environment Variables**, add:
   - Key: `API_KEY`
   - Value: any long random string (30+ characters). If you have access
     to any terminal (even Termux on Android, or macOS/Linux Terminal),
     `openssl rand -hex 24` generates one. Otherwise just type a long
     random mix of letters and numbers yourself - it doesn't need to
     come from a specific tool.
6. Click **Create Web Service**.

## Step 4: Wait for the build
First deploy takes a few minutes (building the Docker image with
Ghostscript). Build logs stream live in the Render dashboard. When done,
you'll see a URL like:

```
https://pdf-compress-bridge.onrender.com
```

## Step 5: Confirm it's alive
Open that URL directly in a browser. You should see:
```
PDF compression bridge is running.
```

## Step 6: Plug it into Apps Script
In `sendEmailsWithAttachments_v3.gs`:
```javascript
var COMPRESSION_BRIDGE_URL = "https://pdf-compress-bridge.onrender.com";
var COMPRESSION_BRIDGE_API_KEY = "the same secret you set in Render's API_KEY env var";
```

## Step 7: Drive scope check (same requirement as any deployment)
In the Apps Script editor: **Project Settings** (gear icon) → check
**"Show appsscript.json manifest file in editor"** → open that file →
confirm `oauthScopes` includes `https://www.googleapis.com/auth/drive`.
The bridge needs to both read the original file and write the compressed
copy back, using the token Apps Script hands it.

## Things specific to Render's free tier
- **Cold starts:** free web services spin down after ~15 minutes of no
  traffic. The first request after idle time takes 30-60 seconds to wake
  up before Ghostscript can run. For an occasional batch job like this,
  that's a one-time delay on the first oversized file per run, not an
  ongoing problem.
- **Monthly free hours:** Render's free tier has a monthly runtime cap
  shared across your free services. For a script that runs occasionally
  rather than continuously, you should be comfortably within it - but if
  you end up running this very frequently, check Render's current free
  tier limits on their pricing page, since these terms can change and my
  knowledge of them may be out of date.

## Updating the service later
If you change `server.js`, `package.json`, or the `Dockerfile`, push the
change to the GitHub repo - Render auto-redeploys on every push to the
connected branch by default.
