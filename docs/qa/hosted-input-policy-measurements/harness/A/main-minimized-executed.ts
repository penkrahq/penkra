import { AppTabObserver } from "../apps/desktop/src/appTabObserver";
import { AppCommandPipeServer } from "../apps/desktop/src/appCommandPipeServer";
import { executePenkraExecCommand } from "../apps/server/src/appRuntimeCli";
import { spawn, spawnSync } from "node:child_process";
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
let shellVisibility = "visible",
  pageVisibility = "visible";
let caseId = "bootstrap";
const info = console.info.bind(console);
console.info = (tag: any, data: any = {}) => {
  fs.appendFileSync(
    path.join(evidence, "events.jsonl"),
    JSON.stringify({ caseId, atMs: performance.now(), epochMs: Date.now(), tag, data }) + "\n",
  );
  info(tag, data);
};
const trace = (event: string, data: any = {}) => {
  if (data.documentVisibility) shellVisibility = data.documentVisibility;
  if (event === "page-event" && data.visibility) pageVisibility = data.visibility;
  console.info("[qa]", { event, ...data });
};
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
    shellDocument: { visibility: shellVisibility, source: "renderer visibility event cache" },
    pageDocument: { visibility: pageVisibility, source: "page visibility event cache" },
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
  process.env.QA_BYPASS_TAB_GUARD = "1";
  const helperLog = fs.openSync(path.join(evidence, "helper.log"), "a");
  const helperProcess = spawn("/usr/bin/osascript", ["-l", "JavaScript", "qa/helper.js"], {
    env: process.env,
    stdio: ["ignore", helperLog, helperLog],
  });
  for (let i = 0; i < 100 && !fs.existsSync(path.join(root, "helper-state.json")); i++)
    await pause(50);
  if (!fs.existsSync(path.join(root, "helper-state.json"))) throw new Error("helper startup");
  const backend = http.createServer((_q, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(fs.readFileSync("qa/probe.html"));
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

  const requestedState = process.env.QA_STATE!,
    policy = process.env.QA_POLICY!;
  let second: BrowserWindow | null = null,
    targetId: number | null = null;
  const samples: any[] = [];
  const trials: any[] = [];
  let serial = 0;
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
  const page = host.target("qa-A", "d2");
  const originalSend = page.debugger.sendCommand.bind(page.debugger);
  (page.debugger as any).sendCommand = async (method: string, params: any, sessionId: any) => {
    const callId = ++serial,
      start = performance.now();
    trace("cdp-start", { callId, method, params, sessionId });
    try {
      const result = await originalSend(method, params, sessionId);
      trace("cdp-end", { callId, method, durationMs: performance.now() - start });
      return result;
    } catch (e) {
      trace("cdp-error", {
        callId,
        method,
        durationMs: performance.now() - start,
        error: String(e),
      });
      throw e;
    }
  };
  page.on("console-message", (event: any, level: any, message: any) => {
    const text = event.message ?? message ?? "";
    if (text.startsWith("QA_PAGE_EVENT ")) trace("page-event", JSON.parse(text.slice(14)));
  });
  const observer = new AppTabObserver({
    resolve: (tabId, document, surfaceId) => ({
      descriptor: host.list().find((t) => t.id === tabId)!,
      document,
      webContents: host.target(tabId, document),
      isPresented: () =>
        shell.isVisible() &&
        !shell.isMinimized() &&
        host.ownerWindowId(tabId) === owner &&
        host.isVisible(tabId),
      canDeliverPointerInput: () => host.canDeliverPointerInput(tabId),
    }),
  });
  for (const name of ["click", "type", "scroll", "snapshot"] as const) {
    const original = (observer as any)[name].bind(observer);
    (observer as any)[name] = async (...args: any[]) => {
      const start = performance.now();
      trace("observer-phase-start", { name });
      try {
        return await original(...args);
      } finally {
        trace("observer-phase-end", { name, durationMs: performance.now() - start });
      }
    };
  }
  const commandServer = new AppCommandPipeServer({
    path: path.join(root, "qa-home", "commands.sock"),
    token: "qa-fixture-command-token",
    catalog: {} as any,
    broker: {} as any,
    tabs: host,
    activate: async () => ({}),
    presentation: () => ({ state: host.isVisible("qa-A") ? "active" : "background" }),
    observationSurface: () => owner,
    observer,
    providerCredentialVault: {} as any,
  });
  await commandServer.start();
  const context = {
    spaceId: "qa-space",
    folderId: "qa-folder",
    threadId: "qa-thread",
    callerTurnId: "qa-turn",
    cwd: evidence,
  };
  async function execute(command: string) {
    const startedEpochMs = Date.now(),
      start = performance.now();
    trace("command-start", { command, startedEpochMs });
    try {
      const result = await executePenkraExecCommand(
        { command },
        context,
        commandServer.environment,
      );
      const row = {
        returned: true,
        ok: true,
        startedEpochMs,
        endedEpochMs: Date.now(),
        durationMs: performance.now() - start,
        result,
      };
      trace("command-end", row);
      return row;
    } catch (e: any) {
      const row = {
        returned: true,
        ok: false,
        startedEpochMs,
        endedEpochMs: Date.now(),
        durationMs: performance.now() - start,
        error: { message: e.message, code: e.code, outcome: e.outcome },
      };
      trace("command-end", row);
      return row;
    }
  }
  async function evaluate(expression: string) {
    if (!page.debugger.isAttached()) page.debugger.attach("1.3");
    const result: any = await page.debugger.sendCommand("Runtime.evaluate", {
      expression,
      returnByValue: true,
    });
    return result.result?.value;
  }
  async function recover() {
    trace("recovery-start");
    if (requestedState === "space") {
      shell.focus();
      await pause(1600);
    } else {
      app.show();
      shell.restore();
      shell.show();
      shell.focus();
      await pause(500);
    }
    trace("recovery-end");
  }
  async function reenter() {
    trace("reenter-state", { requestedState });
    if (requestedState === "space") {
      second!.focus();
      await pause(1600);
    }
    if (requestedState === "minimized") {
      shell.minimize();
      await pause(900);
    }
    if (requestedState === "apphide") {
      app.hide();
      await pause(900);
    }
  }
  async function sample() {
    return {
      ...(await state()),
      shellFullScreen: shell.isFullScreen(),
      secondFullScreen: second?.isFullScreen() ?? false,
      secondSimpleFullScreen: second?.isSimpleFullScreen() ?? false,
      backgroundThrottling: page.getBackgroundThrottling(),
      geometry: geometry(),
    };
  }
  async function sampleSave(label: string) {
    const row = { label, ...(await sample()) };
    samples.push(row);
    fs.writeFileSync(path.join(evidence, "samples.json"), JSON.stringify(samples, null, 2));
    trace("state-sample", row);
    return row;
  }
  async function helper(action: string, extra: any = {}) {
    fs.writeFileSync(
      path.join(root, "helper-control.json"),
      JSON.stringify({ action, serial: Date.now(), ...extra }),
    );
    await pause(500);
  }
  shell.on("focus", () => {
    if (host)
      void host.focusWindow(owner).catch((e) => trace("host-focus-failed", { error: String(e) }));
  });
  async function reset() {
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
      folderId: "qa-folder",
      threadId: "qa-thread",
      windowId: owner,
      bounds: { x: 601, y: 44, width: 399, height: 656 },
      animate: false,
    });
    await pause(800);
  }
  async function full(win: BrowserWindow, value: boolean) {
    for (let i = 0; i < 4; i++) {
      if (value) {
        app.focus({ steal: true });
        win.show();
        win.moveTop();
        win.focus();
        await pause(350);
      }
      trace("fullscreen-request", { id: win.id, value, attempt: i });
      win.setFullScreen(value);
      await pause(3500);
      if (win.isFullScreen() === value) {
        await pause(700);
        return;
      }
    }
    throw new Error("native fullscreen timeout");
  }
  await reset();
  await sampleSave("visible-baseline");
  const snap = await execute("penkra tabs snapshot --tab-id qa-A --document d2");
  const refs: any = (snap as any).result?.refs ?? {};
  const find = (name: string) => Object.entries(refs).find(([k, v]: any) => v.name === name)?.[0];
  if (!find("Click probe") || !find("Text probe")) throw new Error("snapshot refs absent");
  caseId = "enter-" + requestedState;
  if (requestedState === "space") {
    second = new BrowserWindow({ width: 900, height: 700, show: false });
    await second.loadURL(
      "data:text/html,<html><body>QA second native full-screen Space</body></html>",
    );
    await full(shell, true);
    await helper("activate", { x: 1300, y: 100, width: 250, height: 250 });
    await pause(1500);
    second.showInactive();
    await full(second, true);
    shell.focus();
    await pause(1600);
    await sampleSave("first-space-front");
    second.focus();
    await pause(1600);
  }
  if (requestedState === "minimized") {
    shell.minimize();
    await pause(900);
  }
  if (requestedState === "apphide") {
    app.focus({ steal: true });
    shell.focus();
    await pause(150);
    trace("native-app-hide-request");
    app.hide();
    await pause(900);
  }
  if (requestedState === "covered") {
    const g = geometry(),
      b = g.targetWindow?.bounds;
    if (!b) throw new Error("target geometry missing");
    await helper("cover", { x: b.X, y: b.Y, width: b.Width, height: b.Height });
    await pause(700);
  }
  await sampleSave("state-before-trials");
  for (let repetition = 0; repetition < 3; repetition++)
    for (const action of ["click", "type", "scroll"]) {
      const id = `${policy}-${requestedState}-${action}-${repetition}`;
      caseId = id;
      trace("reset-page-start");
      await evaluate(`window.qaReset(${JSON.stringify(id)})`);
      trace("reset-page-end");
      await pause(250);
      const before = await sample();
      const step: any =
        action === "click"
          ? { action, ref: find("Click probe") }
          : action === "type"
            ? { action, ref: find("Text probe"), text: id }
            : { action, document: "d2", deltaY: 400 };
      let returned: any = null;
      const startEpochMs = Date.now();
      const pending = execute(
        `penkra tabs act --input '${JSON.stringify({ tabId: "qa-A", steps: [step] })}'`,
      ).then((v) => {
        returned = v;
        return v;
      });
      const response = await Promise.race([
        pending,
        pause(30000).then(() => ({
          returned: false,
          ok: false,
          startedEpochMs: startEpochMs,
          error: {
            code: "QA_RESPONSE_DEADLINE",
            message: "No command response within 30 seconds; native state unchanged.",
          },
        })),
      ]);
      const immediate = await evaluate("window.qaState()");
      await pause(1100);
      const afterPage = await evaluate("window.qaState()");
      const after = await sample();
      const event = afterPage.events.find(
        (v: any) => v.kind === (action === "type" ? "input" : action) && v.caseId === id,
      );
      const row: any = {
        policy,
        requestedState,
        id,
        repetition,
        action,
        before,
        response,
        immediate,
        afterPage,
        after,
        event: event ?? null,
        pageDelayMs: event ? event.epochMs - response.startedEpochMs : null,
      };
      if (!response.returned) {
        await recover();
        row.recoveryResponse = await Promise.race([
          pending,
          pause(5000).then(() => ({ returned: false, error: "Still pending after recovery" })),
        ]);
        row.recoveryPage = await evaluate("window.qaState()");
        row.recoveryState = await sample();
        await reenter();
      }
      trials.push(row);
      fs.writeFileSync(path.join(evidence, "trials.json"), JSON.stringify(trials, null, 2));
      trace("trial-completed", row);
    }
  caseId = "return";
  trace("return-request", { requestedState });
  if (requestedState === "space") shell.focus();
  if (requestedState === "minimized") shell.restore();
  if (requestedState === "apphide") {
    app.show();
    shell.show();
    shell.focus();
  }
  if (requestedState === "covered") await helper("hide");
  const returnSamples = [];
  for (let i = 0; i < 12; i++) {
    const start = performance.now(),
      row = await sample();
    returnSamples.push({ ...row, atMs: start });
    if (row.geometry.targetWindow?.onScreen) {
      const image = spawnSync(
        "/usr/sbin/screencapture",
        ["-x", "-l", String(targetId), path.join(evidence, `return-${i}.png`)],
        { encoding: "utf8" },
      );
      trace("return-window-capture", { i, status: image.status, stderr: image.stderr });
    }
    await pause(30);
  }
  fs.writeFileSync(
    path.join(evidence, "return-samples.json"),
    JSON.stringify(returnSamples, null, 2),
  );
  if (second) {
    await full(second, false);
    second.hide();
    await full(shell, false);
    second.destroy();
  }
  caseId = "cleanup";
  await helper("quit");
  observer.dispose();
  await commandServer.dispose();
  host.closeAll();
  shell.destroy();
  backend.closeAllConnections();
  web.closeAllConnections();
  await Promise.all([
    new Promise<void>((r) => backend.close(() => r())),
    new Promise<void>((r) => web.close(() => r())),
  ]);
  helperProcess.kill();
  app.exit(0);
}
run().catch((error) => {
  console.error(error);
  fs.writeFileSync(path.join(evidence, "failure.txt"), error.stack ?? String(error));
  app.exit(1);
});
