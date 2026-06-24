// App setup
const { app, BrowserWindow, session, shell } = require('electron');
const path = require('path');

// App identity
app.setAppUserModelId('DM Dash');

// Window create
function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 980,
    minHeight: 720,
    title: 'DM Dash',
    backgroundColor: '#ffffff',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: true,
      devTools: !app.isPackaged
    }
  });

  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'index.html'));

  // Zoom routing
  win.webContents.on('before-input-event', (event, input) => {
    const isShortcut = input.control || input.meta;
    const key = input.key || '';
    if (!isShortcut || !['-', '+', '=', '0'].includes(key)) return;
    event.preventDefault();
    const direction = key === '-' ? -1 : key === '0' ? 0 : 1;
    win.webContents.executeJavaScript(`window.appZoomControl && window.appZoomControl(${direction})`).catch(() => {});
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', event => {
    event.preventDefault();
  });
}

// Security policy
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; object-src 'none'; connect-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'none'"
        ],
        'X-Content-Type-Options': ['nosniff'],
        'Referrer-Policy': ['no-referrer']
      }
    });
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Close handling
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
