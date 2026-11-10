// Run after `npm run build` using an explicitly selected Electron executable.
// Isolated synthetic video only: no app profile, voice connection, microphone or provider.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const output = process.env.STRIPE_TEST_OUTPUT;
if (!output || !path.isAbsolute(output)) throw Error('STRIPE_TEST_OUTPUT must be an absolute private result path');
const home = process.env.STRIPE_TEST_PROFILE;
if (!home || !path.isAbsolute(home)) throw Error('Launch through run.cjs with a private temporary profile');
app.setPath('userData', home);
app.commandLine.appendSwitch('disable-features', 'VaapiVideoDecoder');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (process.env.STRIPE_TEST_FIXTURE) {
  app.commandLine.appendSwitch('disable-gpu-vsync');
  app.commandLine.appendSwitch('disable-frame-rate-limiter');
}
let window;
function finish(code) {
  window?.destroy();
  // The Node launcher cleans the profile AFTER Electron exits: Chromium can
  // write/recreate profile files during shutdown, even after windows close.
  app.exit(code);
}
ipcMain.once('stripe-result', (event, result) => {
  if (!window || event.sender !== window.webContents) return;
  fs.writeFileSync(output, JSON.stringify({ electron: process.versions.electron, ...result }, null, 2), { mode: 0o600 });
  finish(result.ok ? 0 : 1);
});
app.whenReady().then(async () => {
  window = new BrowserWindow({ show: false, focusable: false, width: 320, height: 240,
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  await window.loadFile(path.join(__dirname, process.env.STRIPE_TEST_FIXTURE ? 'performance.html' : 'parity.html'));
  window.showInactive();
}).catch(error => {
  fs.writeFileSync(output, JSON.stringify({ ok: false, error: String(error) }), { mode: 0o600 });
  finish(1);
});
