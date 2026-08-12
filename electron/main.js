const { app, BrowserWindow, dialog, ipcMain, session } = require('electron');
const { promises: fs } = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const security = require('../shared/security');

app.enableSandbox();
app.setAppUserModelId('com.keyouts.dmdash');

const appPage = path.join(__dirname, '..', 'index.html');
const appUrl = pathToFileURL(appPage).href;
const policy = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ');

function trustedSender(event) {
  return event.senderFrame === event.sender.mainFrame && event.senderFrame.url === appUrl;
}

function assertTrustedSender(event) {
  if (!trustedSender(event)) throw new Error('Untrusted renderer request.');
}

function safeSaveName(value) {
  const source = String(value || '').replace(/\.dmdb$/i, '');
  return `${security.sanitizeFilename(source, 'dm-drawing-board')}.dmdb`;
}

async function atomicWrite(filePath, content) {
  const directory = path.dirname(filePath);
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.tmp`);
  await fs.writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'w' });
  try {
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(filePath, { force: true });
    await fs.rename(temporary, filePath);
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 980,
    minHeight: 720,
    title: 'DM Dash',
    backgroundColor: '#ffffff',
    show: false,
    autoHideMenuBar: app.isPackaged,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: true,
      devTools: !app.isPackaged
    }
  });

  win.once('ready-to-show', () => win.show());
  win.webContents.setVisualZoomLevelLimits(1, 1);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('will-redirect', event => event.preventDefault());
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  win.loadFile(appPage);
}

ipcMain.handle('campaign:save', async (event, payload) => {
  assertTrustedSender(event);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid save request.');
  const content = String(payload.content ?? '');
  security.assertImportSize(content);
  const parsed = JSON.parse(content);
  security.validateCampaignDocument(parsed);
  const filename = safeSaveName(payload.filename);
  const result = await dialog.showSaveDialog({
    title: 'Save Campaign',
    defaultPath: filename,
    filters: [{ name: 'DM Dash Campaign', extensions: ['dmdb'] }],
    properties: ['createDirectory', 'showOverwriteConfirmation']
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  const filePath = result.filePath.toLowerCase().endsWith('.dmdb') ? result.filePath : `${result.filePath}.dmdb`;
  await atomicWrite(filePath, content);
  return { canceled: false };
});

ipcMain.handle('campaign:open', async event => {
  assertTrustedSender(event);
  const result = await dialog.showOpenDialog({
    title: 'Open Campaign',
    filters: [{ name: 'DM Dash Campaign', extensions: ['dmdb', 'json'] }],
    properties: ['openFile', 'dontAddToRecent']
  });
  if (result.canceled || result.filePaths.length !== 1) return { canceled: true, content: '' };
  const filePath = result.filePaths[0];
  const stats = await fs.stat(filePath);
  if (!stats.isFile() || stats.size > security.MAX_IMPORT_BYTES) throw new Error('Campaign file exceeds the import limit.');
  const content = await fs.readFile(filePath, 'utf8');
  security.assertImportSize(content);
  security.validateCampaignDocument(JSON.parse(content));
  return { canceled: false, content, name: path.basename(filePath) };
});

app.whenReady().then(() => {
  const activeSession = session.defaultSession;
  activeSession.setPermissionCheckHandler(() => false);
  activeSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  activeSession.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url;
    callback({ cancel: !(url.startsWith('file:') || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('devtools:')) });
  });
  activeSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy],
        'Cross-Origin-Opener-Policy': ['same-origin'],
        'Cross-Origin-Resource-Policy': ['same-origin'],
        'Referrer-Policy': ['no-referrer'],
        'X-Content-Type-Options': ['nosniff'],
        'X-Frame-Options': ['DENY']
      }
    });
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
