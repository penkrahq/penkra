const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pause = (milliseconds = 150) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let smokeStage = 'startup';

async function frameValue(window, expression) {
  return window.webContents.executeJavaScript(`
    (() => {
      const frame = globalThis.document.querySelector('iframe');
      const frameDocument = frame?.contentDocument;
      if (!frameDocument) throw new Error('Pencil frame is unavailable');
      const document = frameDocument;
      return (${expression});
    })()
  `);
}

async function click(window, name) {
  await pause(250);
  await frameValue(window, `(() => {
    const element = document.querySelector('[data-pencil-name="${name}"]');
    if (!element) throw new Error('Missing interactive layer: ${name}');
    element.click();
    return true;
  })()`);
  await pause(250);
}

async function expectFrame(window, rootName) {
  const actual = await frameValue(
    window,
    `document.body.firstElementChild?.getAttribute('data-pencil-name')`,
  );
  if (actual !== rootName) {
    throw new Error(`Expected frame "${rootName}", received "${actual}"`);
  }
}

app.whenReady().then(async () => {
  ipcMain.on('penkra:set-window-mode', (event, mode) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return;
    const size =
      mode === 'onboarding'
        ? [1440, 900]
        : mode === 'workspace-wide'
          ? [1512, 900]
          : [1440, 900];
    window.setAspectRatio(size[0] / size[1]);
    window.setContentSize(...size);
  });

  const window = new BrowserWindow({
    show: false,
    width: 1040,
    height: 640,
    useContentSize: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  await window.loadFile(path.join(root, 'dist', 'index.html'), {
    query: { phase: 'welcome' },
  });
  await pause(300);

  smokeStage = 'welcome frame';
  await expectFrame(window, 'Welcome');
  if (window.getContentSize().join('x') !== '1440x900') {
    throw new Error(`Onboarding shell is ${window.getContentSize().join('x')}`);
  }
  smokeStage = 'native UI font';
  const nativeFont = await frameValue(window, `(async () => {
    try {
      await document.fonts.ready;
      const sample = document.querySelector('[data-pencil-name="Welcome Heading"]');
      return {
        family: sample ? getComputedStyle(sample).fontFamily : '',
        sfProAvailable: document.fonts.check('14px "SF Pro Text"'),
      };
    } catch (error) {
      return { error: String(error), family: '', sfProAvailable: false };
    }
  })()`);
  if (!nativeFont.family.includes('-apple-system') || !nativeFont.sfProAvailable) {
    throw new Error(`Native UI font did not load: ${JSON.stringify(nativeFont)}`);
  }

  smokeStage = 'onboarding navigation';
  await click(window, 'Sign In Button');
  await expectFrame(window, 'Connect an Agent');
  await click(window, 'Codex');
  await click(window, 'Continue Button');
  await expectFrame(window, 'Manage Claude Connections');
  await click(window, 'Enter API Key Button');
  await expectFrame(window, 'Enter API Key');
  await frameValue(window, `(() => {
    const fields = [...document.querySelectorAll('[data-pencil-name="Placeholder"]')];
    const secret = fields.find((field) => field.textContent.includes('••'));
    if (!secret) throw new Error('API key field is unavailable');
    secret.textContent = 'sk-mock-local-only';
    secret.dispatchEvent(new InputEvent('input', { bubbles: true }));
    return true;
  })()`);
  await click(window, 'Save Button');
  await expectFrame(window, 'Install Apps');
  await click(window, 'Continue Button');
  await expectFrame(window, 'Main — 3 rails');
  await pause(500);
  smokeStage = 'native mono font';
  const monoFontStackDeclared = await frameValue(
    window,
    `document.body.innerHTML.includes("SFMono-Regular")`,
  );
  if (!monoFontStackDeclared) {
    throw new Error('SF Mono stack is not declared in the workspace design');
  }

  if (window.getContentSize().join('x') !== '1512x900') {
    throw new Error(`Wide workspace shell is ${window.getContentSize().join('x')}`);
  }

  await click(window, 'Account');
  await click(window, 'Settings');
  await expectFrame(window, 'Settings modal');
  if (window.getContentSize().join('x') !== '1440x900') {
    throw new Error(`Settings shell is ${window.getContentSize().join('x')}`);
  }

  await click(window, 'Apps Row');
  await expectFrame(window, 'Settings — Apps');

  smokeStage = 'settings navigation';
  const settingsScreens = [
    ['Permissions Row', 'Settings — Permissions'],
    ['Agents Row', 'Settings — Agents'],
    ['Connectors Row', 'Settings — Connectors'],
    ['Appearance Row', 'Settings — Appearance'],
    ['Account Row', 'Settings — Account'],
    ['General Row', 'Settings modal'],
    ['Apps Row', 'Settings — Apps'],
  ];
  for (const [row, frame] of settingsScreens) {
    await click(window, row);
    await expectFrame(window, frame);
  }

  smokeStage = 'permission sheet';
  await window.loadFile(path.join(root, 'dist', 'index.html'), {
    query: { phase: 'permission' },
  });
  await pause(300);
  await expectFrame(window, 'Permission request');
  await pause(250);
  const sheetCount = await frameValue(
    window,
    `document.querySelectorAll('[data-pencil-name="Permission Sheet — Ledger install"]').length`,
  );
  if (sheetCount !== 1) {
    throw new Error(`Expected one permission sheet, received ${sheetCount}`);
  }

  await window.webContents.executeJavaScript(`
    (() => {
      const frame = globalThis.document.querySelector('iframe');
      frame?.contentDocument?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      );
    })()
  `);
  await pause(250);
  await expectFrame(window, 'Settings — Apps');

  console.log(
    'Penkra smoke test passed: onboarding → workspace → settings suite → appearance → permission',
  );
  app.quit();
}).catch((error) => {
  console.error(`Smoke stage failed: ${smokeStage}`);
  console.error(error);
  app.exit(1);
});
