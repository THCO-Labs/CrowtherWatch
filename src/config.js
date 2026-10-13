// CrowtherWatch configuration. The API base URL can be overridden with the CROWTHERWATCH_API_URL
// environment variable (useful for staging vs production); otherwise it falls back to the value
// baked in here. The desktop app talks ONLY to the Pebbles API — never to the database or Cloudinary
// with any stored secret. The Cloudinary upload is authorised per-shot by a signed ticket the API
// issues, so this app holds no secret of any kind.
const DEFAULT_API_URL = 'https://pebble-frontier-dev-api.victoriousrock-9cfed1be.canadacentral.azurecontainerapps.io';

module.exports = {
  apiBaseUrl: (process.env.CROWTHERWATCH_API_URL || DEFAULT_API_URL).replace(/\/+$/, ''),
  // How often a screenshot is captured while a session is running.
  captureIntervalMs: 30 * 60 * 1000,
  appVersion: require('../package.json').version,
};
