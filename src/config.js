// CrowtherWatch configuration. The API base URL can be overridden with the CROWTHERWATCH_API_URL
// environment variable (useful for staging vs production); otherwise it falls back to the value
// baked in here. The desktop app holds no storage secret of any kind: the server decides where
// screenshots go (USE_CLOUDINARY) and tells this app per-shot whether to upload directly to
// Cloudinary with a signed ticket, or to relay the bytes through the Pebbles API. The only host
// this app ever talks to directly — besides the Pebbles API — is Cloudinary, and only with a
// short-lived signature the API issues.
const DEFAULT_API_URL = 'https://pebble-frontier-dev-api.victoriousrock-9cfed1be.canadacentral.azurecontainerapps.io';

module.exports = {
  apiBaseUrl: (process.env.CROWTHERWATCH_API_URL || DEFAULT_API_URL).replace(/\/+$/, ''),
  // How often a still screenshot is captured while a session is running.
  captureIntervalMs: 10 * 60 * 1000,
  // Screen video is recorded continuously in self-contained clips of this length; each finished clip
  // is uploaded on its own. (One place to change the cadence — both this and captureIntervalMs are
  // baked into the build, so a change needs a new release.)
  videoSegmentMs: 5 * 60 * 1000,
  // Bitrate cap for the recording. 2.5 Mbit/s × 5 min ≈ 94 MB, so a clip stays far under the store's
  // 500 MB ceiling by construction — we never have to compress one after the fact.
  videoBitsPerSecond: 2_500_000,
  // Hard ceiling the Crowther Blob endpoint accepts. A clip that somehow exceeds this is skipped
  // (with a logged error) rather than failing the upload — the bitrate cap makes it practically
  // impossible to reach anyway.
  maxUploadBytes: 500 * 1024 * 1024,
  appVersion: require('../package.json').version,
};
