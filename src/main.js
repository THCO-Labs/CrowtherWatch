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

// ── Capture one screenshot of the primary display and push it through the signed-upload flow.
//    Each of the three network steps labels its own failures, so a bare "fetch failed" from Node
//    becomes something diagnosable like "Cloudinary upload failed: fetch failed (ECONNRESET)".
async function captureAndUpload() {
  if (!state.sessionId) return;

  // Step 1 (sign) — captured outside the big try so a sign failure is labelled.
  let ticket;
  try {
    ticket = await api('POST', '/api/employee/freelancer/screenshots/sign', { auth: true });
  } catch (e) {
    reportCaptureError('Sign request failed', e);
    return;
  }

  // Step 2 (capture + upload to Cloudinary via Electron's net.fetch, which handles multipart
  // binary uploads reliably — Node's native fetch has had edge-case failures with Blob([Buffer]).
  let uploaded;
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
    const file = new File([bytes], 'screenshot.png', { type: 'image/png' });

    const form = new FormData();
    form.append('file', file);
    form.append('api_key', String(ticket.api_key));
    form.append('timestamp', String(ticket.timestamp));
    form.append('folder', ticket.folder);
    form.append('signature', ticket.signature);

    // net.fetch uses Chromium's network stack rather than Node's — more reliable for multipart.
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

  // Step 3 (record) — if this fails the image is in Cloudinary but Pebbles didn't learn about it;
  // retention cleanup will eventually tidy orphans. We still surface the error.
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
  return { sessionId: session.id, workDate: session.work_date };
});

ipcMain.handle('tracking:stop', async () => {
  if (!state.sessionId) return { ok: true };
  stopCaptureLoop();
  const id = state.sessionId;
  state.sessionId = null;
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
  policy: state.policy,
  captureIntervalMinutes: Math.round(config.captureIntervalMs / 60000),
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
app.on('before-quit', () => { stopCaptureLoop(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
