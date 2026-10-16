const { app, BrowserWindow, ipcMain, desktopCapturer, screen, Tray, nativeImage, net } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const config = require('./config');

// ── In-memory session state. Nothing sensitive is persisted to disk except the one-time consent
//    flag; the access token lives only in memory and is gone when the app closes.
const state = {
  token: null,
  employeeEmail: null,
  policy: null,
  sessionId: null,
  captureTimer: null,
  recording: false,
  lastShotAt: null,
  // Video is only recorded on the server-relay store (Crowther Blob), where the renderer's bytes go
  // through Pebbles. On Cloudinary (client-direct) the tracker keeps screenshots only — unchanged.
  uploadMode: null,
  videoActive: false,
  lastVideoAt: null,
};

let mainWindow = null;
let tray = null;

const consentFile = () => path.join(app.getPath('userData'), 'consent.json');

function hasConsented() {
  try { return JSON.parse(fs.readFileSync(consentFile(), 'utf8')).accepted === true; }
  catch { return false; }
}

function recordConsent() {
  try { fs.writeFileSync(consentFile(), JSON.stringify({ accepted: true, at: new Date().toISOString() })); }
  catch { /* best-effort; if it fails the consent screen simply shows again next launch */ }
}

// ── Pebbles API helpers. The app only ever calls the Pebbles API (and the Cloudinary URL the API
//    signs for it). It never holds a database connection or a Cloudinary secret.
async function api(method, pathname, { body, auth } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && state.token) headers.Authorization = `Bearer ${state.token}`;

  const res = await fetch(`${config.apiBaseUrl}${pathname}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { detail: text }; }

  if (!res.ok) {
    const err = new Error(data?.detail || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function setRecording(on) {
  state.recording = on;
  if (tray) tray.setToolTip(on ? 'CrowtherWatch — recording' : 'CrowtherWatch — idle');
  if (mainWindow) mainWindow.webContents.send('recording-changed', on);
}

// ── Capture one screenshot of the primary display and push it through whichever upload flow the
//    server tells us is live. The server owns the choice via USE_CLOUDINARY, so this app does not
//    care which store is behind it — it just follows the `provider` / `client_direct` fields:
//      • client_direct (Cloudinary): sign a ticket, upload the bytes straight to Cloudinary, then
//        record the resulting URL with Pebbles.
//      • otherwise (e.g. Crowther Blob): the key is server-only, so POST the bytes to Pebbles, which
//        uploads and records them in one call.
//    Each network step labels its own failures, so a bare "fetch failed" becomes diagnosable.
async function captureAndUpload() {
  if (!state.sessionId) return;

  // Step 1 (sign / mode) — captured outside the big try so a sign failure is labelled.
  let ticket;
  try {
    ticket = await api('POST', '/api/employee/freelancer/screenshots/sign', { auth: true });
  } catch (e) {
    reportCaptureError('Sign request failed', e);
    return;
  }

  // Step 2 (capture the PNG once; both upload paths reuse these bytes).
  let file;
  try {
    const display = screen.getPrimaryDisplay();
    const { width, height } = display.size;
    const scale = display.scaleFactor || 1;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) },
    });
    if (sources.length === 0) throw new Error('No screen source available');

    const png = sources[0].thumbnail.toPNG();

    // Build the file from a plain Uint8Array (not a Node Buffer wrapped in a Blob — some runtimes
    // reject that for multipart uploads with a generic "fetch failed").
    const bytes = new Uint8Array(png.buffer, png.byteOffset, png.byteLength);
    file = new File([bytes], 'screenshot.png', { type: 'image/png' });
  } catch (e) {
    reportCaptureError('Screen capture failed', e);
    return;
  }

  // Server-relay path (provider's key is server-only): one multipart POST to Pebbles, which uploads
  // to the configured store and records the screenshot. net.fetch uses Chromium's network stack,
  // which handles multipart binary uploads more reliably than Node's fetch.
  if (ticket.client_direct === false || (ticket.provider && ticket.provider !== 'cloudinary')) {
    try {
      const uploadPath = ticket.upload_path || '/api/employee/freelancer/screenshots/upload';
      const form = new FormData();
      form.append('file', file);
      form.append('session_id', state.sessionId);
      form.append('captured_at', new Date().toISOString());

      const res = await net.fetch(`${config.apiBaseUrl}${uploadPath}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${state.token}` },
        body: form,
      });
      const text = await res.text();
      if (!res.ok) {
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
        throw new Error(data?.detail || data?.error?.message || `Upload responded ${res.status}`);
      }

      state.lastShotAt = new Date().toISOString();
      if (mainWindow) mainWindow.webContents.send('shot-taken', state.lastShotAt);
    } catch (e) {
      reportCaptureError('Screenshot upload failed', e);
    }
    return;
  }

  // Client-direct path (Cloudinary): upload the bytes straight to Cloudinary with the signed ticket.
  let uploaded;
  try {
    const form = new FormData();
    form.append('file', file);
    form.append('api_key', String(ticket.api_key));
    form.append('timestamp', String(ticket.timestamp));
    form.append('folder', ticket.folder);
    form.append('signature', ticket.signature);

    const uploadRes = await net.fetch(ticket.upload_url, { method: 'POST', body: form });
    const text = await uploadRes.text();
    try { uploaded = text ? JSON.parse(text) : null; } catch { uploaded = null; }
    if (!uploadRes.ok || !uploaded?.secure_url) {
      throw new Error(uploaded?.error?.message || `Cloudinary responded ${uploadRes.status}`);
    }
  } catch (e) {
    reportCaptureError('Cloudinary upload failed', e);
    return;
  }

  // Record — if this fails the image is in Cloudinary but Pebbles didn't learn about it; retention
  // cleanup will eventually tidy orphans. We still surface the error.
  try {
    await api('POST', '/api/employee/freelancer/screenshots', {
      auth: true,
      body: {
        session_id: state.sessionId,
        cloudinary_url: uploaded.secure_url,
        cloudinary_public_id: uploaded.public_id,
        captured_at: new Date().toISOString(),
      },
    });

    state.lastShotAt = new Date().toISOString();
    if (mainWindow) mainWindow.webContents.send('shot-taken', state.lastShotAt);
  } catch (e) {
    reportCaptureError('Could not record screenshot with Pebbles', e);
  }
}

function reportCaptureError(label, e) {
  // Node's fetch wraps the real cause under `.cause` — surfacing it turns "fetch failed" into
  // something like "ECONNRESET" or "ENOTFOUND api.cloudinary.com".
  const cause = e?.cause?.code || e?.cause?.message;
  const msg = cause ? `${label}: ${e.message} (${cause})` : `${label}: ${e.message}`;
  if (mainWindow) mainWindow.webContents.send('capture-error', msg);
}

function startCaptureLoop() {
  stopCaptureLoop();
  // One shot shortly after starting (immediate proof the session is live), then every interval.
  setTimeout(() => captureAndUpload(), 5000);
  state.captureTimer = setInterval(() => captureAndUpload(), config.captureIntervalMs);
}

function stopCaptureLoop() {
  if (state.captureTimer) { clearInterval(state.captureTimer); state.captureTimer = null; }
}

// ── Screen video. MediaRecorder lives in the renderer, so main's job is only to hand it the desktop
//    source id + cadence, and to upload each finished clip the renderer ships back. Everything here is
//    best-effort: if video can't start or a clip fails, screenshots carry on untouched.
async function startVideoRecording() {
  if (!mainWindow || state.videoActive) return;
  let sourceId = null;
  try {
    // thumbnailSize {0,0}: we only need the source id, not a preview image.
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    sourceId = sources.length ? sources[0].id : null;
  } catch (e) {
    reportCaptureError('Video recording could not start', e);
    return;
  }
  if (!sourceId) { reportCaptureError('Video recording', new Error('no screen source available')); return; }

  state.videoActive = true;
  mainWindow.webContents.send('video:start', {
    sourceId,
    segmentMs: config.videoSegmentMs,
    bitsPerSecond: config.videoBitsPerSecond,
    maxBytes: config.maxUploadBytes,
  });
}

function stopVideoRecording() {
  if (!state.videoActive) return;
  state.videoActive = false;
  if (mainWindow) mainWindow.webContents.send('video:stop');
}

// Upload one finished clip the renderer recorded. Reuses the same server-relay route as a relayed
// screenshot: a multipart POST to Pebbles, which stores it and records the row. The token never
// leaves main.
ipcMain.handle('video:segment', async (_e, payload) => {
  if (!state.sessionId || !payload || !payload.buffer) return { ok: false };

  const size = payload.buffer.byteLength || 0;
  if (size === 0) return { ok: false };
  if (size > (config.maxUploadBytes || Infinity)) {
    reportCaptureError('Video clip skipped',
      new Error(`clip is ${Math.round(size / 1048576)}MB, over the ${Math.round(config.maxUploadBytes / 1048576)}MB limit`));
    return { ok: false };
  }

  try {
    const uploadPath = (state.uploadMode && state.uploadMode.uploadPath) || '/api/employee/freelancer/screenshots/upload';
    const ext = payload.ext || 'webm';
    const mimeType = payload.mimeType || 'video/webm';
    const file = new File([new Uint8Array(payload.buffer)], `recording-${Date.now()}.${ext}`, { type: mimeType });

    const form = new FormData();
    form.append('file', file);
    form.append('session_id', state.sessionId);
    form.append('captured_at', payload.capturedAt || new Date().toISOString());

    const res = await net.fetch(`${config.apiBaseUrl}${uploadPath}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${state.token}` },
      body: form,
    });
    const text = await res.text();
    if (!res.ok) {
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
      throw new Error(data?.detail || data?.error?.message || `Upload responded ${res.status}`);
    }

    state.lastVideoAt = new Date().toISOString();
    if (mainWindow) mainWindow.webContents.send('video-saved', state.lastVideoAt);
    return { ok: true };
  } catch (e) {
    reportCaptureError('Video clip upload failed', e);
    return { ok: false };
  }
});

ipcMain.on('video:error', (_e, msg) => reportCaptureError('Video recording', new Error(msg)));

// ── IPC: the renderer drives these; all network/capture work stays in the main process.
ipcMain.handle('consent:get', () => hasConsented());
ipcMain.handle('consent:accept', () => { recordConsent(); return true; });

ipcMain.handle('auth:init', async (_e, { email, password }) => {
  await api('POST', '/api/auth/2fa/init', { body: { email, password } });
  return { ok: true };
});

ipcMain.handle('auth:verify', async (_e, { email, code }) => {
  const data = await api('POST', '/api/auth/2fa/verify', { body: { email, code, user_type: 'employee' } });
  state.token = data.access_token;
  state.employeeEmail = email;

  // Freelancer gate: only an employee WITH a policy may use the tracker. 404 ⇒ not a freelancer.
  try {
    state.policy = await api('GET', '/api/employee/freelancer/policy', { auth: true });
  } catch (e) {
    state.token = null;
    if (e.status === 404) throw new Error('This account is not set up as a freelancer. Ask your admin.');
    throw e;
  }
  return { email, policy: state.policy };
});

ipcMain.handle('tracking:start', async () => {
  if (!state.token) throw new Error('Not signed in');
  if (state.sessionId) return { sessionId: state.sessionId };
  const session = await api('POST', '/api/employee/freelancer/sessions', {
    auth: true,
    body: { device_label: os.hostname(), app_version: config.appVersion },
  });
  state.sessionId = session.id;
  setRecording(true);
  startCaptureLoop();

  // Decide the upload mode once per session. Video only runs on the server-relay store (Crowther
  // Blob), where the key is server-side; on Cloudinary we keep the existing screenshot-only flow.
  try {
    const mode = await api('POST', '/api/employee/freelancer/screenshots/sign', { auth: true });
    if (mode && mode.client_direct === false) {
      state.uploadMode = { relay: true, uploadPath: mode.upload_path || '/api/employee/freelancer/screenshots/upload' };
      await startVideoRecording();
    } else {
      state.uploadMode = { relay: false };
    }
  } catch (e) {
    // A sign failure here only means no video this session; screenshots have their own per-shot sign.
    reportCaptureError('Could not start video recording', e);
  }

  return { sessionId: session.id, workDate: session.work_date };
});

ipcMain.handle('tracking:stop', async () => {
  if (!state.sessionId) return { ok: true };
  stopCaptureLoop();
  stopVideoRecording();
  const id = state.sessionId;
  state.sessionId = null;
  state.uploadMode = null;
  setRecording(false);
  try { await api('POST', `/api/employee/freelancer/sessions/${id}/stop`, { auth: true }); }
  catch (e) { /* the session still ends locally; the server also closes it on the next start */ }
  return { ok: true };
});

ipcMain.handle('update:install', () => { autoUpdater.quitAndInstall(); });

// ── Auto-update (electron-updater against the GitHub Releases feed). Checks on launch; downloads in
//    the background; tells the renderer when an update is ready so the user can restart into it.
//    Only runs in a packaged build — there is nothing to update in dev.
function setupAutoUpdate() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.on('update-downloaded', (info) => {
    if (mainWindow) mainWindow.webContents.send('update-ready', info.version);
  });
  // Update failures must never block the app — log to the renderer quietly and carry on.
  autoUpdater.on('error', (err) => {
    if (mainWindow) mainWindow.webContents.send('update-error', String(err?.message || err));
  });
  autoUpdater.checkForUpdates().catch(() => { /* offline or no release yet — ignore */ });
}

ipcMain.handle('status:get', () => ({
  signedIn: !!state.token,
  email: state.employeeEmail,
  recording: state.recording,
  sessionId: state.sessionId,
  lastShotAt: state.lastShotAt,
  lastVideoAt: state.lastVideoAt,
  policy: state.policy,
  captureIntervalMinutes: Math.round(config.captureIntervalMs / 60000),
  videoSegmentMinutes: Math.round(config.videoSegmentMs / 60000),
}));

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 460,
    height: 680,
    resizable: false,
    title: 'CrowtherWatch',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  try {
    tray = new Tray(nativeImage.createEmpty());
    tray.setToolTip('CrowtherWatch — idle');
  } catch { /* tray is best-effort */ }

  createWindow();
  setupAutoUpdate();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

// Stopping cleanly matters: if the app is quitting mid-session, end the capture loop so no further
// screenshots are taken after the user has walked away.
app.on('before-quit', () => { stopCaptureLoop(); stopVideoRecording(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
