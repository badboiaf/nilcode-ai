// NILCODE AI desktop shell. Boots the exact same NILCODE server (bundled once
// at build time) as a plain Node child process, then shows the existing web
// UI in a real desktop window. No product logic lives here by design: same
// UI, same auth (including Google sign-in and desktop pairing), same AI,
// same projects, chats and uploads. No API keys are embedded in this app —
// the server resolves providers from its own server-side configuration.
const { app, BrowserWindow, shell, Menu } = require('electron');
const { spawn } = require('node:child_process');
const { join, dirname } = require('node:path');
const { readFileSync } = require('node:fs');
const net = require('node:net');

const IS_PACKAGED = app.isPackaged;
const APP_ROOT = IS_PACKAGED ? join(process.resourcesPath, 'app-server') : dirname(__dirname);
const SERVER_BUNDLE = join(APP_ROOT, 'server-bundle.cjs');
const SERVER_ENTRY = join(APP_ROOT, 'server', 'index.js'); // dev mode only

const MIN_WIDTH = 960;
const MIN_HEIGHT = 600;

let serverProcess = null;
let mainWindow = null;
let serverPort = 0;

// Read a .env file from the writable per-user data folder (documented config
// location for AI/Google settings of a desktop install). Never overrides real
// environment variables; values never leave the server process.
function loadUserDataEnv() {
  const envPath = join(app.getPath('userData'), '.env');
  try {
    const content = readFileSync(envPath, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    // No user .env — fine.
  }
}

function getFreePort(preferred) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(getFreePort(0)));
    srv.listen(preferred || 0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function startServer(port) {
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    // Per-user writable data location (accounts, projects, attachments).
    NULLCODE_DATA_DIR: join(app.getPath('userData'), 'data'),
    // Dev mode only: point the server at the repo's static assets.
    ...(IS_PACKAGED ? {} : { NULLCODE_PUBLIC_DIR: join(APP_ROOT, 'public') }),
  };
  if (IS_PACKAGED) {
    // Run the bundled server as plain Node inside Electron's runtime.
    serverProcess = spawn(process.execPath, [SERVER_BUNDLE], {
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } else {
    // Dev mode: run the unbundled server from the repo, also as plain Node.
    serverProcess = spawn(process.execPath, [SERVER_ENTRY], {
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  }
  serverProcess.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  serverProcess.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  serverProcess.on('exit', (code) => {
    serverProcess = null;
    if (mainWindow && !mainWindow.isDestroyed() && code !== 0) {
      mainWindow.webContents.send?.('nilcode:server-exit', code);
    }
  });
}

function waitForServer(port, timeoutMs = 30000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      try {
        // The app serves its index at / — good enough as a liveness probe,
        // and it exercises the exact surface the window will load.
        const res = await fetch(`http://127.0.0.1:${port}/`);
        if (res.ok) return resolve();
      } catch { /* not up yet */ }
      if (Date.now() - started > timeoutMs) return reject(new Error('Server did not start in time.'));
      setTimeout(attempt, 300);
    };
    attempt();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    title: 'NILCODE AI',
    show: false,
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Keep the product in the app window. Google's sign-in popup must open
  // here (GIS delivers the credential back through window.opener); genuine
  // external sites still open in the user's default browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (
      url.startsWith(`http://127.0.0.1:${serverPort}`) ||
      url.startsWith('https://accounts.google.com') ||
      url.startsWith('https://ssl.gstatic.com') ||
      url.startsWith('https://www.google.com')
    ) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 480, height: 640, autoHideMenuBar: true } };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.loadURL(`http://127.0.0.1:${serverPort}/`);
}

// Minimal menu (default roles only — no product UI invented here).
function buildMenu() {
  const template = [
    ...(process.platform === 'darwin'
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        }]
      : []),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    loadUserDataEnv();
    serverPort = await getFreePort(4310);
    try {
      startServer(serverPort);
      await waitForServer(serverPort);
    } catch (err) {
      const { dialog } = require('electron');
      dialog.showErrorBox('NILCODE AI', `The NILCODE AI server failed to start.\n\n${err.message}`);
      app.quit();
      return;
    }
    buildMenu();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', () => {
    if (serverProcess) {
      try { serverProcess.kill(); } catch { /* already gone */ }
      serverProcess = null;
    }
  });
}
