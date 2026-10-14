const { app, BrowserWindow, ipcMain, desktopCapturer, screen, Tray, nativeImage } = require('electron');
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
async function captureAndUpload() {
  if (!state.sessionId) return;
  try {
    const display = screen.getPrimaryDisplay();
    const { width, height } = display.size;
    const scale = display.scaleFactor || 1;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) },
    });
    if (sources.length === 0) return;

    const png = sources[0].thumbnail.toPNG();

    // 1. Ask the API to sign an upload (the API holds the Cloudinary secret, not this app).
    const ticket = await api('POST', '/api/employee/freelancer/screenshots/sign', { auth: true });

    // 2. Upload the bytes straight to Cloudinary with the signed fields.
    const form = new FormData();
    form.append('file', new Blob([png], { type: 'image/png' }), 'screenshot.png');
    form.append('api_key', String(ticket.api_key));
    form.append('timestamp', String(ticket.timestamp));
    form.append('folder', ticket.folder);
    form.append('signature', ticket.signature);

    const uploadRes = await fetch(ticket.upload_url, { method: 'POST', body: form });
    const uploaded = await uploadRes.json();
    if (!uploadRes.ok || !uploaded.secure_url) {
      throw new Error(uploaded?.error?.message || 'Cloudinary upload failed');
    }

    // 3. Record the stored screenshot against the session.
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
    if (mainWindow) mainWindow.webContents.send('capture-error', e.message);
  }
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
