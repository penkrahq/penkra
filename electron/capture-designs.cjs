const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

const projectRoot = path.join(__dirname, '..');
const sourceRoot = path.join(projectRoot, 'public', 'pencil');
const outputRoot = process.env.PENKRA_CAPTURE_OUTPUT
  ? path.resolve(process.env.PENKRA_CAPTURE_OUTPUT)
  : path.join(projectRoot, '.qa-artifacts', 'design-captures');

const screens = [
  ['welcome', 1440, 900],
  ['agents', 1440, 900],
  ['connections', 1440, 900],
  ['api-key', 1440, 900],
  ['apps', 1440, 900],
  ['workspace', 1512, 900],
  ['apps-panel', 1440, 900],
  ['permission', 1440, 900],
  ['settings', 1440, 900],
  ['settings-permissions', 1440, 900],
  ['settings-agents', 1440, 900],
  ['settings-apps', 1440, 900],
  ['settings-connectors', 1440, 900],
  ['settings-appearance', 1440, 900],
  ['settings-account', 1440, 900],
];

app.whenReady().then(async () => {
  await fs.mkdir(outputRoot, { recursive: true });
  const window = new BrowserWindow({
    show: false,
    width: 1512,
    height: 900,
    useContentSize: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
    },
  });

  for (const [name, width, height] of screens) {
    window.setContentSize(width, height);
    await window.loadFile(path.join(sourceRoot, `${name}.html`));
    await window.webContents.executeJavaScript('document.fonts.ready');
    const image = await window.webContents.capturePage({ x: 0, y: 0, width, height });
    await fs.writeFile(path.join(outputRoot, `${name}.png`), image.toPNG());
    console.log(`Captured ${name} (${width}×${height})`);
  }

  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
