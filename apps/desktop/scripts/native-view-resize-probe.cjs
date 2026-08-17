// Isolates Electron WebContentsView resizing from renderer/main IPC. The main
// process applies each requested bound immediately, while the guest deliberately
// takes 45 ms to react. Edge markers reveal gutters; 20 px stripes reveal scaling.
const { app, BrowserWindow, WebContentsView } = require("electron");

app.commandLine.appendSwitch("use-mock-keychain");
app.setPath("userData", require("node:fs").mkdtempSync("/tmp/penkra-native-view-probe-"));
app
  .whenReady()
  .then(run)
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });

async function run() {
  const window = new BrowserWindow({
    backgroundColor: "#101114",
    frame: false,
    height: 700,
    show: true,
    skipTaskbar: true,
    width: 1200,
    webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true },
  });
  const view = new WebContentsView({
    webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true },
  });
  window.contentView.addChildView(view);
  await window.loadURL(hostUrl());
  view.setBackgroundColor("#f733ea");
  view.setBounds({ x: 840, y: 96, width: 360, height: 604 });
  await view.webContents.loadURL(guestUrl());
  await settleFrames(window, 4);

  const samples = [];
  for (const pointerX of [760, 650, 540, 430, 320]) {
    const left = pointerX - 16;
    const width = 1200 - left;
    await window.webContents.executeJavaScript(
      `document.querySelector('[data-panel]').style.width='${width}px'`,
      true,
    );
    view.setBounds({ x: left, y: 96, width, height: 604 });
    samples.push(await capture(view, { left, width, pointerX }));
  }
  await settleFrames(window, 8);
  const settled = await capture(view, { left: 304, width: 896, pointerX: 320 });
  console.log(JSON.stringify({ electron: process.versions.electron, samples, settled }, null, 2));
  view.webContents.close();
  window.destroy();
  app.exit(0);
}

async function capture(view, geometry) {
  const image = await view.webContents.capturePage();
  const size = image.getSize();
  const bitmap = image.toBitmap();
  const scale = size.width / geometry.width;
  const y = Math.floor(size.height / 2);
  const left = readPixel(bitmap, size.width, Math.floor(6 * scale), y);
  const right = readPixel(bitmap, size.width, Math.floor((geometry.width - 6) * scale), y);
  const transitions = countTransitions(
    bitmap,
    size.width,
    y,
    Math.floor(20 * scale),
    Math.floor((geometry.width - 20) * scale),
  );
  return { ...geometry, capturedSize: size, left, right, transitions };
}

function countTransitions(bitmap, bitmapWidth, y, startX, endX) {
  let transitions = 0;
  let previous = classifyStripe(readPixel(bitmap, bitmapWidth, startX, y));
  for (let x = startX + 1; x <= endX; x += 1) {
    const next = classifyStripe(readPixel(bitmap, bitmapWidth, x, y));
    if (next !== previous && next !== "other" && previous !== "other") transitions += 1;
    if (next !== "other") previous = next;
  }
  return transitions;
}

function classifyStripe(pixel) {
  // NativeImage is BGRA. Values allow for macOS color conversion.
  if (pixel[2] > 170 && pixel[0] < 120) return "red";
  if (pixel[0] > 170 && pixel[2] < 120) return "blue";
  return "other";
}

function readPixel(bitmap, width, x, y) {
  const offset = (y * width + x) * 4;
  return [...bitmap.subarray(offset, offset + 4)];
}

async function settleFrames(window, count) {
  await window.webContents.executeJavaScript(
    `new Promise((resolve) => {
    let remaining = ${count};
    const tick = () => (--remaining <= 0 ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  })`,
    true,
  );
}

function hostUrl() {
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><style>
    html,body{width:100%;height:100%;margin:0;overflow:hidden;background:#101114}
    [data-panel]{position:absolute;inset-block:0;right:0;width:360px;background:#f733ea}
  </style><div data-panel></div>`)}`;
}

function guestUrl() {
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><style>
    html,body{width:100%;height:100%;margin:0;overflow:hidden}
    body{background:repeating-linear-gradient(90deg,#e33030 0 20px,#305fe3 20px 40px)}
    body::before,body::after{content:'';position:fixed;z-index:2;inset-block:0;width:12px}
    body::before{left:0;background:#f4df45}body::after{right:0;background:#42efdf}
  </style><script>addEventListener('resize',()=>{const end=performance.now()+45;while(performance.now()<end){}})<\/script>`)}`;
}
