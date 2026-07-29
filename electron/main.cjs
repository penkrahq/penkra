const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const stateDirectory = process.env.PENKRA_DEV_STATE_DIRECTORY;
const electronPidFile = stateDirectory ? path.join(stateDirectory, 'electron.pid') : undefined;
const rendererReadyFile = stateDirectory
  ? path.join(stateDirectory, 'renderer-ready.json')
  : undefined;
const runtimeFailureFile = stateDirectory
  ? path.join(stateDirectory, 'runtime-failure.json')
  : undefined;

function diagnostic(event, details = {}) {
  console.log(
    `[penkra-electron] ${JSON.stringify({
      timestamp: new Date().toISOString(),
      event,
      pid: process.pid,
      ...details,
    })}`,
  );
}

function reportRuntimeFailure(event, details = {}) {
  if (rendererReadyFile) fs.rmSync(rendererReadyFile, { force: true });
  if (runtimeFailureFile) {
    fs.writeFileSync(
      runtimeFailureFile,
      `${JSON.stringify({ timestamp: new Date().toISOString(), event, ...details }, null, 2)}\n`,
    );
  }
}

function createWindow() {
  diagnostic('window:create');
  const window = new BrowserWindow({
    width: 1040,
    height: 640,
    useContentSize: true,
    minWidth: 860,
    minHeight: 560,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#0f1115',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  window.webContents.on('did-finish-load', () => {
    const details = { url: window.webContents.getURL() };
    if (runtimeFailureFile) fs.rmSync(runtimeFailureFile, { force: true });
    if (rendererReadyFile) {
      fs.writeFileSync(
        rendererReadyFile,
        `${JSON.stringify({ timestamp: new Date().toISOString(), ...details }, null, 2)}\n`,
      );
    }
    diagnostic('window:loaded', details);
  });
  window.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      const details = {
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame,
      };
      reportRuntimeFailure('window:load-failed', details);
      diagnostic('window:load-failed', details);
    },
  );
  window.webContents.on('render-process-gone', (_event, details) => {
    reportRuntimeFailure('renderer:gone', details);
    diagnostic('renderer:gone', details);
  });
  window.on('unresponsive', () => {
    reportRuntimeFailure('window:unresponsive');
    diagnostic('window:unresponsive');
  });
  window.on('responsive', () => diagnostic('window:responsive'));

  if (process.env.VITE_DEV_SERVER_URL) {
    diagnostic('window:load-url', { url: process.env.VITE_DEV_SERVER_URL });
    window.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    const query = process.env.PENKRA_CAPTURE_PHASE
      ? { phase: process.env.PENKRA_CAPTURE_PHASE }
      : undefined;
    window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { query });
  }

  if (process.env.PENKRA_CAPTURE_FILE) {
    window.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const image = await window.webContents.capturePage();
        fs.writeFileSync(process.env.PENKRA_CAPTURE_FILE, image.toPNG());
        app.quit();
      }, 1500);
    });
  }
}

app.whenReady().then(() => {
  if (electronPidFile) {
    fs.mkdirSync(stateDirectory, { recursive: true });
    fs.rmSync(rendererReadyFile, { force: true });
    fs.rmSync(runtimeFailureFile, { force: true });
    fs.writeFileSync(electronPidFile, `${process.pid}\n`);
  }
  diagnostic('app:ready');
  ipcMain.on('penkra:set-window-mode', (event, mode) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return;

    const [width, height] =
      mode === 'onboarding'
        ? [1440, 900]
        : mode === 'workspace-wide'
          ? [1512, 900]
          : [1440, 900];
    const [currentWidth, currentHeight] = window.getContentSize();
    window.setAspectRatio(width / height);
    if (currentWidth === width && currentHeight === height) return;

    window.setContentSize(width, height, true);
    window.center();
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('child-process-gone', (_event, details) => {
  diagnostic('child-process:gone', details);
});

process.on('uncaughtException', (error) => {
  diagnostic('main:uncaught-exception', {
    message: error.message,
    stack: error.stack,
  });
});

process.on('unhandledRejection', (reason) => {
  diagnostic('main:unhandled-rejection', {
    reason: reason instanceof Error ? reason.stack : String(reason),
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || process.env.PENKRA_DEV_LAUNCHER === '1') app.quit();
});

app.on('will-quit', () => {
  if (electronPidFile) fs.rmSync(electronPidFile, { force: true });
  if (rendererReadyFile) fs.rmSync(rendererReadyFile, { force: true });
  diagnostic('app:will-quit');
});
