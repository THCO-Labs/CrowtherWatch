const { contextBridge, ipcRenderer } = require('electron');

// The renderer never touches Node, the network or the screen directly — it only calls these
// typed bridges, which the main process implements. contextIsolation is on.
contextBridge.exposeInMainWorld('cw', {
  getConsent: () => ipcRenderer.invoke('consent:get'),
  acceptConsent: () => ipcRenderer.invoke('consent:accept'),
  initAuth: (email, password) => ipcRenderer.invoke('auth:init', { email, password }),
  verifyAuth: (email, code) => ipcRenderer.invoke('auth:verify', { email, code }),
  startTracking: () => ipcRenderer.invoke('tracking:start'),
  stopTracking: () => ipcRenderer.invoke('tracking:stop'),
  getStatus: () => ipcRenderer.invoke('status:get'),
  onRecordingChanged: (cb) => ipcRenderer.on('recording-changed', (_e, on) => cb(on)),
  onShotTaken: (cb) => ipcRenderer.on('shot-taken', (_e, at) => cb(at)),
  onCaptureError: (cb) => ipcRenderer.on('capture-error', (_e, msg) => cb(msg)),
  onUpdateReady: (cb) => ipcRenderer.on('update-ready', (_e, version) => cb(version)),
  installUpdate: () => ipcRenderer.invoke('update:install'),

  // Screen-recording bridges. MediaRecorder is a DOM API, so recording runs in the renderer, but the
  // main process still owns the token and the network: main tells the renderer when to start/stop and
  // with which desktop source, and the renderer ships each finished clip's bytes back for upload.
  onStartVideo: (cb) => ipcRenderer.on('video:start', (_e, payload) => cb(payload)),
  onStopVideo: (cb) => ipcRenderer.on('video:stop', () => cb()),
  sendVideoSegment: (payload) => ipcRenderer.invoke('video:segment', payload),
  reportVideoError: (msg) => ipcRenderer.send('video:error', String(msg)),
  onVideoSaved: (cb) => ipcRenderer.on('video-saved', (_e, at) => cb(at)),
});
