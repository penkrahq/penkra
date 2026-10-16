import { spawnSync } from "node:child_process";
import { app, BrowserWindow, ipcMain, session, protocol } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { AppTabViewHost } from "../apps/desktop/src/appTabViewHost";
import { createAppRendererPreferences } from "../apps/desktop/src/appRuntimePolicy";
const root = process.env.QA_ROOT!;
const evidence = path.join(root, "evidence");
app.setPath("userData", path.join(root, "qa-home"));
app.setPath("sessionData", path.join(root, "qa-home"));
app.setName("Penkra QA visibility history");
protocol.registerSchemesAsPrivileged([
  { scheme: "penkra-app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
let caseId = "bootstrap";
const info = console.info.bind(console);
console.info = (tag: any, data: any = {}) => {
  fs.appendFileSync(
    path.join(evidence, "events.jsonl"),
    JSON.stringify({ caseId, atMs: performance.now(), epochMs: Date.now(), tag, data }) + "\n",
  );
  info(tag, data);
};
const trace = (event: string, data: any = {}) => console.info("[qa]", { event, ...data });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
let shell: BrowserWindow, host: AppTabViewHost;
let owner: number;
let latest: any = {};
let ready = false;
function traceAppTabWindow(win: BrowserWindow, event: string) {
  const data = {
    windowId: win.id,
    rendererId: win.webContents.id,
    isVisible: win.isVisible(),
    isMinimized: win.isMinimized(),
    isFocused: win.isFocused(),
  };
  trace(event, data);
}
async function setAppTabWindowVisibility(id: number, visible: boolean) {
  await host.setWindowVisibility(id, visible);
}
async function state() {
  const page = host.target("qa-A", "d2");
  return {
    epochMs: Date.now(),
    appHidden: app.isHidden(),
    shellVisible: shell.isVisible(),
    shellMinimized: shell.isMinimized(),
    shellFocused: shell.isFocused(),
    tabVisible: host.isVisible("qa-A"),
    ownerWindowId: host.ownerWindowId("qa-A"),
    childViews: shell.contentView.children.map((v) => ({
      id: (v as any).webContents?.id,
      visible: v.getVisible(),
    })),
    pageId: page.id,
    appId: host.target("qa-A", "d1").id,
    shellDocument: await shell.webContents.executeJavaScript(
      '({visibility:document.visibilityState,focus:document.hasFocus(),replica:!!document.querySelector("[data-app-tab-replica]"),text:document.body.innerText})',
    ),
    pageDocument: await page.executeJavaScript(
      "({visibility:document.visibilityState,focus:document.hasFocus(),counter:window.counter})",
    ),
    presentation: {
      tabId: latest.tabId,
      mode: latest.mode,
      ownerWindowId: latest.ownerWindowId,
      appImage: !!latest.appFrameDataUrl,
      pageImage: !!latest.pageFrameDataUrl,
    },
  };
}
async function run() {
  await app.whenReady();
  const backend = http.createServer((_q, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      '<html><body style="background:#d0f0c0"><h2>QA live hosted page</h2><b id="counter"></b><script>window.counter=0;setInterval(()=>document.getElementById("counter").textContent=++window.counter,50)</script></body></html>',
    );
  });
  await new Promise<void>((r) => backend.listen(3919, "127.0.0.1", r));
  const web = http.createServer((req, res) => {
    if (req.url === "/renderer.js") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(fs.readFileSync("qa/bundle/renderer.js"));
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end(
      '<html><head><style>html,body,#root{height:100%;margin:0}.h-full{height:100%}.w-full{width:100%}.relative{position:relative}.absolute{position:absolute}.inset-0{inset:0}.overflow-hidden{overflow:hidden}img{object-fit:fill}.bg-background{background:white}</style></head><body><h2>QA visibility shell</h2><div id="root"></div><script type="module" src="/renderer.js"></script></body></html>',
    );
  });
  await new Promise<void>((r) => web.listen(5919, "127.0.0.1", r));
  shell = new BrowserWindow({
    width: 1000,
    height: 700,
    x: 70,
    y: 70,
    show: true,
    webPreferences: {
      preload: path.resolve("qa/preload.cjs"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  owner = shell.webContents.id;
  const window = shell;
  const rendererOwnerId = owner;
  window.on("hide", () => {
    traceAppTabWindow(window, "shell-window-hide");
    void setAppTabWindowVisibility(rendererOwnerId, false);
  });
  window.on("show", () => {
    traceAppTabWindow(window, "shell-window-show");
    void setAppTabWindowVisibility(rendererOwnerId, true);
  });
  window.on("minimize", () => {
    traceAppTabWindow(window, "shell-window-minimize");
    void setAppTabWindowVisibility(rendererOwnerId, false);
  });
  window.on("restore", () => {
    traceAppTabWindow(window, "shell-window-restore");
    void setAppTabWindowVisibility(rendererOwnerId, true);
  });

  for (const event of [
    "focus",
    "blur",
    "hide",
    "show",
    "minimize",
    "restore",
    "enter-full-screen",
    "leave-full-screen",
  ])
    shell.on(event, () =>
      trace("raw-window-" + event, {
        visible: shell.isVisible(),
        minimized: shell.isMinimized(),
        focused: shell.isFocused(),
      }),
    );
  for (const event of [
    "browser-window-focus",
    "browser-window-blur",
    "did-become-active",
    "did-resign-active",
    "activate",
  ])
    app.on(event as any, () => trace("raw-app-" + event));
  const browserPackage: any = {
    appId: "com.penkra.browser",
    slug: "browser",
    name: "Browser",
    packagePath: process.cwd(),
    manifest: { entrypoints: { tab: "browser.html" }, agentAddressable: true, permissions: [] },
  };
  const partition = createAppRendererPreferences({
    appId: "com.penkra.browser",
    spaceId: "qa-space",
    preloadPath: path.resolve("qa/app-preload.cjs"),
  }).partition;
  await session
    .fromPartition(partition)
    .protocol.handle(
      "penkra-app",
      () =>
        new Response(
          '<html><body style="margin:0;background:transparent"><div style="height:48px;background:white">QA Browser toolbar</div></body></html>',
          { headers: { "Content-Type": "text/html" } },
        ),
    );
  host = new AppTabViewHost({
    installations: {} as any,
    sessions: { get: () => ({ origin: "penkra-app://a-" + "1".repeat(64) }) } as any,
    broker: { registerTab: () => () => {} } as any,
    rpc: { registerTarget: () => () => {}, request: async () => ({}) } as any,
    ipcBridge: { waitForReady: async () => {} } as any,
    preloadPath: path.resolve("qa/app-preload.cjs"),
    windowById: (id) => (id === owner ? shell : null),
    hasShellWindow: () => true,
    resolveIconDataUrl: async () => null,
    onBeforeOpened: async () => ({}),
    onOpened: () => {},
    onRouteChanged: async () => {},
    onCloseTab: async () => {},
    onState: () => {},
    onPresentation: (id, v) => {
      latest = v;
      shell.webContents.send("qa-presentation", v);
      trace("presentation", {
        windowId: id,
        mode: v.mode,
        ownerWindowId: v.ownerWindowId,
        appImage: !!v.appFrameDataUrl,
        pageImage: !!v.pageFrameDataUrl,
      });
    },
  } as any);
  await host.open({
    tabId: "qa-A",
    app: browserPackage,
    spaceId: "qa-space",
    deckId: "qa-folder",
    folderId: "qa-folder",
    threadId: "qa-thread",
    route: "/",
    initiator: "agent",
  } as any);
  await host.openHostedPage("qa-A", "http://127.0.0.1:3919/probe");
  host.setHostedPageTop("qa-A", 48);
  ipcMain.handle("qa-seed", () => ({
    tabId: "qa-A",
    rendererId: host.target("qa-A", "d1").id,
    deckId: "qa-folder",
    folderId: "qa-folder",
    threadId: "qa-thread",
    status: "ready",
    visible: true,
    animateEntrance: false,
    animationStartedAtEpochMs: null,
    appName: "Browser",
  }));
  ipcMain.on("qa-ready", () => (ready = true));
  ipcMain.on("qa-trace", (_e, v) => trace(v.event, v.details));
  ipcMain.handle("qa-present", async (_e, v) => {
    await host.presentInWindow({
      ...v,
      deckId: "qa-folder",
      folderId: "qa-folder",
      windowId: owner,
    });
    return {};
  });
  ipcMain.handle("qa-hide", async (_e, v) => {
    await host.hideInWindow(v.tabId, owner, false);
    return {};
  });
  await shell.loadURL("http://127.0.0.1:5919/");
  for (let i = 0; i < 200 && !ready; i++) await pause(50);
  if (!ready) throw new Error("QA renderer not ready");
  await pause(800);
  app.focus({ steal: true });
  shell.focus();
  await pause(350);
  const os: any[] = [];
  let targetId: number | null = null;
  let second: BrowserWindow | null = null;
  function geometry() {
    const helper = JSON.parse(fs.readFileSync(path.join(root, "helper-state.json"), "utf8"));
    const out = spawnSync(
      "python3",
      ["qa/cg-window-list.py", String(process.pid), String(helper.pid)],
      { encoding: "utf8" },
    );
    if (out.status !== 0) throw new Error(out.stderr);
    const d = JSON.parse(out.stdout);
    if (targetId === null)
      targetId =
        d.windows.find(
          (w: any) =>
            w.pid === process.pid &&
            w.bounds.X === 70 &&
            w.bounds.Y === 70 &&
            w.bounds.Width === 1000 &&
            w.bounds.Height === 700,
        )?.windowId ?? null;
    return {
      ...d,
      targetWindow: d.windows.find((w: any) => w.windowId === targetId) ?? null,
      helper,
    };
  }
  async function sample() {
    return {
      ...(await state()),
      shellFullScreen: shell.isFullScreen(),
      secondFullScreen: second?.isFullScreen() ?? null,
      secondSimpleFullScreen: second?.isSimpleFullScreen() ?? null,
      geometry: geometry(),
    };
  }
  async function record(name: string, count = 5) {
    caseId = name;
    trace("samples-started", { name });
    const samples = [];
    for (let i = 0; i < count; i++) {
      samples.push(await sample());
      await pause(200);
    }
    const v = { caseId: name, samples };
    os.push(v);
    fs.writeFileSync(path.join(evidence, "native-results.json"), JSON.stringify(os, null, 2));
    trace("samples-finished", { name });
    return v;
  }
  async function helper(action: string, extra: any = {}) {
    fs.writeFileSync(
      path.join(root, "helper-control.json"),
      JSON.stringify({ action, serial: Date.now(), ...extra }),
    );
    await pause(400);
  }
  async function reset() {
    caseId = "reset";
    await helper("hide");
    app.show();
    shell.restore();
    shell.show();
    shell.setBounds({ x: 70, y: 70, width: 1000, height: 700 });
    app.focus({ steal: true });
    shell.moveTop();
    shell.focus();
    await host.setWindowVisibility(owner, true);
    await host.presentInWindow({
      tabId: "qa-A",
      deckId: "qa-folder",
      folderId: "qa-folder",
      threadId: "qa-thread",
      windowId: owner,
      bounds: { x: 601, y: 44, width: 399, height: 656 },
    } as any);
    await pause(700);
    for (let i = 0; i < 5; i++) {
      const current = await state();
      if (
        current.shellVisible &&
        !current.shellMinimized &&
        current.tabVisible &&
        current.ownerWindowId === owner &&
        current.shellDocument.visibility === "visible"
      )
        break;
      await host.setWindowVisibility(owner, true);
      await host.presentInWindow({
        tabId: "qa-A",
        folderId: "qa-folder",
        deckId: "qa-folder",
        threadId: "qa-thread",
        windowId: owner,
        bounds: { x: 601, y: 44, width: 399, height: 656 },
      } as any);
      await pause(500);
    }
  }
  shell.on("focus", () => {
    if (host)
      void host.focusWindow(owner).catch((e) => trace("host-focus-failed", { message: String(e) }));
  });
  async function focusBaseline() {
    for (let i = 0; i < 4 && !shell.isFocused(); i++) {
      app.focus({ steal: true });
      shell.moveTop();
      shell.focus();
      await pause(150);
    }
    trace("immediate-action-baseline", {
      visible: shell.isVisible(),
      minimized: shell.isMinimized(),
      focused: shell.isFocused(),
      tabVisible: host.isVisible("qa-A"),
      appHidden: app.isHidden(),
    });
  }
  await reset();
  await record("visible-baseline", 3);
  caseId = "app-loses-focus";
  await focusBaseline();
  trace("action-started", { action: "outside-frame helper activate" });
  await helper("show", { x: 1300, y: 100, width: 250, height: 250 });
  await record("app-loses-focus", 6);
  await reset();
  caseId = "minimize";
  trace("action-started", { action: "shell.minimize" });
  shell.minimize();
  await pause(450);
  await record("minimize", 5);
  shell.restore();
  await pause(700);
  await record("restore", 3);
  await reset();
  caseId = "cmd-h-equivalent";
  await focusBaseline();
  trace("action-started", { action: "app.hide; Cmd-H native app-hide equivalent" });
  app.hide();
  await pause(450);
  await record("cmd-h-equivalent", 5);
  app.show();
  shell.show();
  shell.focus();
  await pause(700);
  await record("unhide", 3);
  await reset();
  second = new BrowserWindow({ width: 900, height: 700, show: false });
  await second.loadURL("data:text/html,<html><body>QA second shell Space</body></html>");
  async function full(win: BrowserWindow, value: boolean, id: string) {
    caseId = id;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (value) {
        app.focus({ steal: true });
        win.show();
        win.moveTop();
        win.focus();
        await pause(350);
      }
      let entered = false;
      const event = value ? "enter-full-screen" : "leave-full-screen";
      const listener = () => (entered = true);
      win.once(event, listener);
      trace("fullscreen-request", { id, attempt, windowId: win.id, value });
      win.setFullScreen(value);
      await pause(3500);
      win.removeListener(event, listener);
      if (entered || win.isFullScreen() === value) {
        await pause(700);
        return;
      }
    }
    throw new Error("QA fullscreen did not complete " + id);
  }
  await full(shell, true, "first-enters-fullscreen");
  await record("first-fullscreen", 3);
  caseId = "switch-desktop-for-setup";
  await helper("show", { x: 1300, y: 100, width: 250, height: 250 });
  await pause(1500);
  second.showInactive();
  await full(second, true, "second-enters-fullscreen");
  await record("second-fullscreen-selected", 4);
  caseId = "space-return-first";
  trace("action-started", { action: "focus existing first fullscreen Space" });
  shell.focus();
  await pause(1600);
  await record("space-return-first", 4);
  caseId = "space-switch-second";
  trace("action-started", { action: "focus existing second fullscreen Space" });
  second.focus();
  await pause(1600);
  await record("space-switch-second", 6);
  await full(second, false, "leave-second-fullscreen");
  second.hide();
  await full(shell, false, "leave-first-fullscreen");
  second.destroy();
  await helper("quit");
  caseId = "cleanup";
  host.closeAll();
  shell.destroy();
  backend.closeAllConnections();
  web.closeAllConnections();
  await Promise.all([
    new Promise<void>((r) => backend.close(() => r())),
    new Promise<void>((r) => web.close(() => r())),
  ]);
  app.exit(0);
}
run().catch((error) => {
  console.error(error);
  fs.writeFileSync(path.join(evidence, "failure.txt"), error.stack ?? String(error));
  app.exit(1);
});
