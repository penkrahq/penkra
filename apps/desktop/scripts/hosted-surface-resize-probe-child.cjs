const { appendFileSync, writeFileSync } = require("node:fs");
const { app, BrowserWindow } = require("electron");

app.commandLine.appendSwitch("use-mock-keychain");
app.commandLine.appendSwitch("site-per-process");
app.setPath("userData", requiredPath("PENKRA_HOSTED_SURFACE_PROBE_PROFILE"));
app.whenReady().then(run).catch(fail);

async function run() {
  const captureFrames = Number.parseInt(
    process.env.PENKRA_HOSTED_SURFACE_PROBE_CAPTURE_FRAMES ?? "0",
    10,
  );
  const scenario = process.env.PENKRA_HOSTED_SURFACE_PROBE_SCENARIO ?? "custom";
  const renderPaced = scenario === "rejected-staged-heavy-stall";
  const stallMs = Number.parseInt(process.env.PENKRA_HOSTED_SURFACE_PROBE_STALL_MS ?? "45", 10);
  const window = new BrowserWindow({
    backgroundColor: "#101114",
    frame: false,
    height: 700,
    show: true,
    skipTaskbar: true,
    width: 1200,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  });

  try {
    await window.loadURL(probeDocumentUrl(renderPaced));
    await waitFor(window, "window.__probe?.ready === true");
    await settleFrames(window, 4);

    const bounds = window.getContentBounds();
    const y = Math.round(bounds.height / 2);
    const startX = bounds.width - 344;
    const samples = [];
    window.webContents.sendInputEvent({ type: "mouseMove", x: startX, y });
    window.webContents.sendInputEvent({
      type: "mouseDown",
      x: startX,
      y,
      button: "left",
      clickCount: 1,
    });
    await waitFor(window, "window.__probe?.pointerDown === true");

    for (const x of [760, 650, 540, 430, 320]) {
      window.webContents.sendInputEvent({ type: "mouseMove", x, y, button: "left" });
      await waitFor(window, `window.__probe?.lastPointerX === ${x}`);
      if (renderPaced) {
        await waitFor(
          window,
          "window.__probe?.transitionActive === true || window.__probe?.presentedWidth === window.__probe?.pendingWidth",
        );
      }
      if (captureFrames > 0) await settleFrames(window, captureFrames);
      samples.push(await captureSample(window, x));
    }

    window.webContents.sendInputEvent({
      type: "mouseUp",
      x: 320,
      y,
      button: "left",
      clickCount: 1,
    });
    await waitFor(window, "window.__probe?.pointerDown === false");
    const release = await captureSample(window, 320);
    if (renderPaced) {
      await waitFor(
        window,
        "window.__probe?.transitionActive === false && window.__probe?.presentedWidth === window.__probe?.pendingWidth",
      );
    }
    await settleFrames(window, 8);
    const settled = await captureSample(window, 320);
    writeFileSync(
      requiredPath("PENKRA_HOSTED_SURFACE_PROBE_RESULT"),
      JSON.stringify({
        electron: process.versions.electron,
        scenario,
        captureFrames,
        stallMs,
        samples,
        release,
        settled,
        observedOuterExposure: samples.some((sample) => sample.outer.exposedAtEitherEdge),
        observedWebviewExposure: samples.some((sample) => sample.webview.exposedAtEitherEdge),
        observedDividerLag: samples.some(
          (sample) => sample.geometry.presentedWidth !== sample.geometry.pendingWidth,
        ),
        overlayStayedAbove: [...samples, release, settled].every(
          (sample) => sample.overlay.isShellOverlay,
        ),
      }),
    );
    window.destroy();
    app.exit(0);
  } catch (error) {
    window.destroy();
    fail(error);
  }
}

async function captureSample(window, pointerX) {
  const geometry = await window.webContents.executeJavaScript(
    `(() => {
    const panel = document.querySelector('[data-probe-panel]');
    const appFrame = document.querySelector('iframe');
    const webview = document.querySelector('webview');
    return {
      pointerX: window.__probe.lastPointerX,
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      panel: panel.getBoundingClientRect().toJSON(),
      appFrame: appFrame.getBoundingClientRect().toJSON(),
      webview: webview.getBoundingClientRect().toJSON(),
      outerReportedWidth: window.__probe.outerReportedWidth,
      pendingWidth: window.__probe.pendingWidth,
      presentedWidth: window.__probe.presentedWidth,
      transitionActive: window.__probe.transitionActive,
    };
  })()`,
    true,
  );
  const image = await window.webContents.capturePage();
  const size = image.getSize();
  const bitmap = image.toBitmap();
  const scaleX = size.width / geometry.viewport.width;
  const scaleY = size.height / geometry.viewport.height;
  const visibleLeft = geometry.viewport.width - geometry.presentedWidth;
  const leftX = Math.floor((visibleLeft + 8) * scaleX);
  const rightX = Math.floor((geometry.panel.right - 8) * scaleX);
  const outerY = Math.floor(48 * scaleY);
  const webviewY = Math.floor(300 * scaleY);
  const outerLeft = readPixel(bitmap, size.width, leftX, outerY);
  const outerRight = readPixel(bitmap, size.width, rightX, outerY);
  const webviewLeft = readPixel(bitmap, size.width, leftX, webviewY);
  const webviewRight = readPixel(bitmap, size.width, rightX, webviewY);
  const overlayPixel = readPixel(
    bitmap,
    size.width,
    Math.floor((geometry.panel.right - 100) * scaleX),
    Math.floor(240 * scaleY),
  );
  // NativeImage bitmaps are BGRA and macOS color conversion shifts saturated colors.
  const outer = classifyEdges(outerLeft, outerRight, [69, 116, 217]);
  const webview = classifyEdges(webviewLeft, webviewRight, [73, 61, 54]);
  return {
    pointerX,
    geometry,
    outer,
    webview,
    overlay: { pixel: overlayPixel, isShellOverlay: isNear(overlayPixel, [84, 221, 245]) },
  };
}

function classifyEdges(left, right, surfaceColor) {
  const leftIsSurface = isNear(left, surfaceColor);
  const rightIsSurface = isNear(right, surfaceColor);
  return {
    left,
    right,
    leftIsSurface,
    rightIsSurface,
    leftIsHostBackground: isNear(left, [20, 17, 16]),
    rightIsHostBackground: isNear(right, [20, 17, 16]),
    leftIsFallback: isNear(left, [227, 71, 228]),
    rightIsFallback: isNear(right, [227, 71, 228]),
    fallbackAtEitherEdge: isNear(left, [227, 71, 228]) || isNear(right, [227, 71, 228]),
    exposedAtEitherEdge: !leftIsSurface || !rightIsSurface,
  };
}

function readPixel(bitmap, width, x, y) {
  const offset = (y * width + x) * 4;
  return [...bitmap.subarray(offset, offset + 4)];
}

function isNear(channels, expected) {
  return expected.every((channel, index) => Math.abs(channels[index] - channel) < 16);
}

async function waitFor(window, expression, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(expression, true)) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`Timed out waiting for ${expression}.`);
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

function probeDocumentUrl(renderPaced) {
  const stallMs = Number.parseInt(process.env.PENKRA_HOSTED_SURFACE_PROBE_STALL_MS ?? "45", 10);
  const outerChild = `<!doctype html><meta charset="utf-8"><style>
    html,body{width:100%;height:100%;margin:0;overflow:hidden;background:rgb(0,200,80)}
    header{height:96px;background:rgb(232,109,55)}
  </style><header></header><script>
    const report=()=>parent.postMessage({type:'probe-outer-width',width:innerWidth},'*');
    addEventListener('resize',()=>{const until=performance.now()+${stallMs};while(performance.now()<until){}report()});
    report();
  <\/script>`;
  const webviewChild = `<!doctype html><meta charset="utf-8"><style>
    html,body{width:100%;height:100%;margin:0;overflow:hidden;background:rgb(52,61,74)}
  </style><script>
    addEventListener('resize',()=>{const until=performance.now()+${stallMs};while(performance.now()<until){}});
  <\/script>`;
  const document = `<!doctype html><meta charset="utf-8"><style>
    *{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden;background:rgb(16,17,20)}
    [data-probe-panel]{position:absolute;inset-block:0;right:0;width:360px;overflow:hidden;background:rgb(247,51,234)}
    [data-probe-content]{position:absolute;inset-block:0;right:0;width:100%;overflow:hidden}
    iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
    webview{position:absolute;z-index:1;inset:96px 0 0;display:flex;background:rgb(247,51,234)}
    [data-probe-rail]{position:absolute;z-index:2;inset-block:0;left:0;width:32px;cursor:col-resize}
    [data-shell-overlay]{position:fixed;z-index:999;top:220px;right:40px;width:600px;height:60px;background:rgb(250,220,40)}
  </style><section data-probe-panel><div data-probe-content><iframe sandbox="allow-scripts" src="data:text/html;charset=utf-8,${encodeURIComponent(outerChild)}"></iframe><webview src="data:text/html;charset=utf-8,${encodeURIComponent(webviewChild)}"></webview></div><div data-probe-rail></div></section><div data-shell-overlay></div><script>
    const panel=document.querySelector('[data-probe-panel]');const content=document.querySelector('[data-probe-content]');const rail=document.querySelector('[data-probe-rail]');const webview=document.querySelector('webview');
    const renderPaced=${JSON.stringify(renderPaced)};
    window.__probe={ready:false,outerReady:false,webviewReady:false,pointerDown:false,lastPointerX:null,outerReportedWidth:null,pendingWidth:360,presentedWidth:360,transitionActive:false};
    const updateReady=()=>window.__probe.ready=window.__probe.outerReady&&window.__probe.webviewReady;
    addEventListener('message',event=>{if(event.data?.type!=='probe-outer-width')return;window.__probe.outerReportedWidth=event.data.width;window.__probe.outerReady=true;updateReady()});
    webview.addEventListener('dom-ready',()=>{window.__probe.webviewReady=true;updateReady()});
    rail.addEventListener('pointerdown',event=>{window.__probe.pointerDown=true;window.__probe.startX=event.clientX;window.__probe.startWidth=panel.getBoundingClientRect().width});
    const waitForSurfaces=async target=>{while(window.__probe.outerReportedWidth!==target)await new Promise(resolve=>setTimeout(resolve,2));await webview.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')};
    const drainResizeQueue=async()=>{if(window.__probe.transitionActive)return;window.__probe.transitionActive=true;try{while(window.__probe.presentedWidth!==window.__probe.pendingWidth){const target=window.__probe.pendingWidth;if(target>window.__probe.presentedWidth){content.style.width=target+'px';await waitForSurfaces(target);panel.style.width=target+'px';window.__probe.presentedWidth=target}else{panel.style.width=target+'px';window.__probe.presentedWidth=target;content.style.width=target+'px';await waitForSurfaces(target)}}}finally{window.__probe.transitionActive=false;if(window.__probe.presentedWidth!==window.__probe.pendingWidth)void drainResizeQueue()}};
    addEventListener('pointermove',event=>{if(!window.__probe.pointerDown)return;window.__probe.lastPointerX=event.clientX;const width=Math.max(240,window.__probe.startWidth+window.__probe.startX-event.clientX);window.__probe.pendingWidth=width;if(renderPaced)void drainResizeQueue();else{panel.style.width=width+'px';window.__probe.presentedWidth=width}});
    addEventListener('pointerup',()=>{window.__probe.pointerDown=false});
  <\/script>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(document)}`;
}

function fail(error) {
  appendFileSync(
    requiredPath("PENKRA_HOSTED_SURFACE_PROBE_LOG"),
    `[${new Date().toISOString()}] ${error?.stack ?? error}\n`,
  );
  app.exit(1);
}

function requiredPath(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
