const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('fs/promises');
const path = require('path');

const root = path.resolve(__dirname, '..');

async function source(file) {
  return readFile(path.join(root, file), 'utf8');
}

test('uses local application files', async () => {
  const main = await source('electron/main.js');
  assert.match(main, /pathToFileURL/);
  assert.match(main, /loadFile\(appPage\)/);
  assert.doesNotMatch(main, /https?:\/\//);
});

test('keeps renderer privileges narrow', async () => {
  const main = await source('electron/main.js');
  const preload = await source('electron/preload.js');
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /sandbox:\s*true/);
  assert.match(main, /webSecurity:\s*true/);
  assert.match(main, /allowRunningInsecureContent:\s*false/);
  assert.match(main, /webviewTag:\s*false/);
  assert.match(main, /setPermissionRequestHandler/);
  assert.match(main, /setWindowOpenHandler/);
  assert.match(preload, /contextBridge\.exposeInMainWorld/);
  assert.doesNotMatch(preload, /ipcRenderer:\s*ipcRenderer/);
  assert.doesNotMatch(preload, /ipcRenderer\.on/);
});

test('restricts local content and ipc', async () => {
  const main = await source('electron/main.js');
  assert.match(main, /event\.senderFrame === event\.sender\.mainFrame/);
  assert.match(main, /event\.senderFrame\.url === appUrl/);
  assert.match(main, /connect-src 'none'/);
  assert.match(main, /object-src 'none'/);
  assert.match(main, /frame-src 'none'/);
  assert.match(main, /validateCampaignDocument/);
  assert.match(main, /url\.startsWith\('file:'\)/);
});
