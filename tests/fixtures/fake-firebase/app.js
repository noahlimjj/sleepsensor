// Minimal fake of firebase-app.js for UI tests.
const _apps = [];
export function initializeApp(config) {
  const app = { options: config, name: '[DEFAULT]' };
  _apps.push(app);
  return app;
}
export function getApps() {
  return _apps;
}
