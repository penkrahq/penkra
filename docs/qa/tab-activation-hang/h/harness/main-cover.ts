import { app, BrowserWindow, ipcMain, session, protocol, webContents } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { AppTabActivation } from "../apps/desktop/src/appTabActivation";
import { AppTabViewHost } from "../apps/desktop/src/appTabViewHost";
import { AppCommandPipeServer } from "../apps/desktop/src/appCommandPipeServer";
import { DESKTOP_IPC_CHANNELS } from "../apps/desktop/src/ipcChannels";
import {
  announceAppTabOpened as routeAppTabOpened,
  AppTabWindowFocusOrder,
  appTabFolderUnavailable,
} from "../apps/desktop/src/appTabOpenedRouting";
import { ThreadHomeWindow } from "../apps/desktop/src/threadHomeWindow";
import { PanelFocusState } from "../apps/desktop/src/panelFocus";
import { readDesktopFolderAppTabs } from "../apps/desktop/src/desktopFolderAppTabsClient";
import { createAppRendererPreferences } from "../apps/desktop/src/appRuntimePolicy";
import { executePenkraExecCommand } from "../apps/server/src/appRuntimeCli";

type DesktopAppTabDescriptor = any;
type DesktopAppTabOpened = any;
const qaRoot = process.env.QA_ROOT!;
app.setPath("userData", path.join(qaRoot, "qa-home"));
app.setPath("sessionData", path.join(qaRoot, "qa-home"));
app.setName("Penkra activation diagnostic harness");
protocol.registerSchemesAsPrivileged([
  { scheme: "penkra-app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
let caseId = "bootstrap";
const logFile = path.join(qaRoot, "evidence", "events.jsonl");
const originalInfo = console.info.bind(console);
console.info = (tag: any, details: any = {}) => {
  fs.appendFileSync(
    logFile,
    JSON.stringify({ caseId, observedAtMs: performance.now(), tag, details }) + "\n",
  );
  originalInfo(tag, details);
};
const diagnostic = (event: string, details: any = {}) =>
  console.info("[qa-control]", { event, ...details });
const IPC = DESKTOP_IPC_CHANNELS;
const threadHomeWindow = new ThreadHomeWindow();
const appTabWindowFocusOrder = new AppTabWindowFocusOrder();
const panelFocusState = new PanelFocusState();
const appTabActivation = new AppTabActivation();
const spacesMenuStateByShellRendererId = new Map<number, any>();
let desktopAppRuntime: any;
let shell: BrowserWindow;
const shellWindows = () => (shell && !shell.isDestroyed() ? [shell] : []);
const backendHttpUrl = "http://127.0.0.1:3919";
const DESKTOP_BACKEND_SHUTDOWN_TOKEN = "qa-fixture-backend-token";
const formatErrorMessage = (e: any) => String(e?.message ?? e);
let appTabDiagnosticSequence = 0;
let folderTabs: any = {
  folderId: "qa-folder",
  folderTitle: "QA folder",
  updatedAt: "2026-10-14T00:00:00.000Z",
  tabs: { panes: [] },
};
let gate: { promise: Promise<void>; release: () => void } | null = null;
function makeGate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}
function requireShellAppTabs(id: number) {
  if (id !== shell.webContents.id) throw new Error("Not the QA shell");
  return desktopAppRuntime.appTabs;
}
async function presentAppTabInWindow(input: any) {
  if (gate) {
    diagnostic("presentation-gated", input);
    await gate.promise;
  }
  await desktopAppRuntime.appTabs.presentInWindow(input);
}
async function hideAppTabInWindow(tabId: string, windowId: number, animate: boolean) {
  await desktopAppRuntime.appTabs.hideInWindow(tabId, windowId, animate);
}
async function setAppTabWindowVisibility(windowId: number, visible: boolean) {
  await desktopAppRuntime.appTabs.setWindowVisibility(windowId, visible);
}

let claimGate: any = null;
const originalClaim = appTabActivation.claim.bind(appTabActivation);
(appTabActivation as any).claim = (requestId: string, windowId: number) => {
  const finish = () => {
    const accepted = originalClaim(requestId, windowId);
    diagnostic("activation-claim-result", { requestId, windowId, accepted });
    return accepted;
  };
  if (claimGate) {
    diagnostic("activation-claim-gated", { requestId, windowId });
    return claimGate.promise.then(finish);
  }
  return finish();
};

import { AppTabObserver } from "../apps/desktop/src/appTabObserver";
import { resolveBrowserUploadFile } from "../apps/desktop/src/browserUploadFile";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { screen } from "electron";
const presentationEvents = new EventEmitter();
function routeAppTab(
  descriptor: Pick<DesktopAppTabOpened, "threadId" | "folderId" | "spaceId" | "initiator">,
) {
  return routeAppTabOpened({
    descriptor,
    windows: appTabWindowFocusOrder.order(
      shellWindows()
        .filter((window) => !window.isDestroyed() && !window.webContents.isLoadingMainFrame())
        .map((window) => {
          const snapshot = threadHomeWindow.snapshot(window.id);
          return {
            id: window.id,
            focused: window.isFocused(),
            visible: window.isVisible(),
            minimized: window.isMinimized(),
            spaceId:
              spacesMenuStateByShellRendererId.get(window.webContents.id)?.activeSpaceId ?? null,
            folderId:
              snapshot?.views.find((view) => view.threadId === snapshot.activeThreadId)?.folderId ??
              null,
          };
        }),
    ),
    home: threadHomeWindow,
    panelFocus: panelFocusState,
  });
}
function appTabAgentPresentation(
  tab: DesktopAppTabDescriptor,
  _threadId: string,
): { state: "active" | "background" | "window-hidden" } {
  const tabs = desktopAppRuntime!.appTabs;
  const ownerId = tabs.ownerWindowId(tab.id);
  const window = shellWindows().find((candidate) => candidate.webContents.id === ownerId);
  if (!window || !window.isVisible() || window.isMinimized()) return { state: "window-hidden" };
  return {
    state:
      tabs.ownerWindowId(tab.id) === window.webContents.id && tabs.isVisible(tab.id)
        ? "active"
        : "background",
  };
}

async function activateAppTabForAgent(
  tab: DesktopAppTabDescriptor,
  threadId: string,
  signal: AbortSignal,
): Promise<unknown> {
  const route = routeAppTab({ ...tab, threadId, initiator: "agent" });
  const window = shellWindows().find((candidate) => candidate.id === route.targetWindowId);
  if (!backendHttpUrl) throw new Error("The backend is not ready.");
  const folderTabs = await readDesktopFolderAppTabs(
    { url: backendHttpUrl, token: DESKTOP_BACKEND_SHUTDOWN_TOKEN },
    tab.folderId,
  );
  if (!folderTabs) throw new Error("The folder is not available.");
  if (!window) throw appTabFolderUnavailable(folderTabs.folderTitle, route.folderShown);
  if (
    desktopAppRuntime!.appTabs.ownerWindowId(tab.id) !== window.webContents.id ||
    !desktopAppRuntime!.appTabs.isVisible(tab.id)
  ) {
    await appTabActivation.request(
      tab.id,
      window.webContents.id,
      signal,
      () => routeAppTab({ ...tab, threadId, initiator: "agent" }).targetWindowId === window.id,
      (request) => {
        window.webContents.send(IPC.appTabs.activationRequested, {
          requestId: request.requestId,
          tab,
          folderTabs,
        });
      },
    );
  }
  signal.throwIfAborted();
  if (
    desktopAppRuntime!.appTabs.ownerWindowId(tab.id) !== window.webContents.id ||
    !desktopAppRuntime!.appTabs.isVisible(tab.id)
  ) {
    throw Object.assign(new Error("The tab lost presentation during activation."), {
      code: "TAB_NOT_ACTIVE",
      dispatched: false,
    });
  }
  return { tabId: tab.id, state: "active", readyForInteraction: true };
}

function traceAppTab(event: string, details: Record<string, unknown> = {}): void {
  console.info("[app-tab-diagnostic]", {
    ...details,
    sequence: ++appTabDiagnosticSequence,
    monotonicMs: Math.round(performance.now()),
    event,
  });
}

function traceAppTabWindow(window: BrowserWindow, event: string): void {
  const details = {
    browserWindowId: window.id,
    rendererId: window.webContents.id,
    isVisible: window.isVisible(),
    isMinimized: window.isMinimized(),
    isFocused: window.isFocused(),
  };
  void window.webContents
    .executeJavaScript(
      "({ visibilityState: document.visibilityState, hasFocus: document.hasFocus() })",
    )
    .then((rendererState: unknown) => traceAppTab(event, { ...details, rendererState }))
    .catch((error: unknown) => {
      traceAppTab(event, { ...details, rendererStateError: formatErrorMessage(error) });
    });
}

async function waitUntil(fn: () => Promise<boolean> | boolean, label: string, limit = 15000) {
  const start = performance.now();
  while (performance.now() - start < limit) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("QA wait timed out: " + label);
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function run() {
  await app.whenReady();
  const fixtureServer = http.createServer((req, res) => {
    if (req.url?.startsWith("/probe")) {
      res.setHeader("Content-Type", "text/html");
      res.end(fs.readFileSync(path.join(process.cwd(), "qa/probe.html")));
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, result: folderTabs }));
  });
  await new Promise<void>((resolve, reject) => {
    fixtureServer.once("error", reject);
    fixtureServer.listen(3919, "127.0.0.1", resolve);
  });
  shell = new BrowserWindow({
    width: 1200,
    height: 800,
    show: true,
    webPreferences: {
      preload: path.join(process.cwd(), "qa/preload.cjs"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  const window = shell;
  const rendererOwnerId = shell.webContents.id;
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

  threadHomeWindow.view(shell.id, "qa-agent-thread", "qa-folder", true, true);
  spacesMenuStateByShellRendererId.set(rendererOwnerId, { activeSpaceId: "qa-space" });
  appTabWindowFocusOrder.focus(shell.id);
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
    preloadPath: path.join(process.cwd(), "qa/app-preload.cjs"),
  }).partition;
  await session.fromPartition(partition).protocol.handle(
    "penkra-app",
    () =>
      new Response("<html><body>Local Browser toolbar fixture</body></html>", {
        headers: { "Content-Type": "text/html" },
      }),
  );
  const host = new AppTabViewHost({
    installations: {} as any,
    sessions: { get: () => ({ origin: "penkra-app://a-" + "1".repeat(64) }) } as any,
    broker: { registerTab: () => () => {} } as any,
    rpc: { registerTarget: () => () => {}, request: async () => ({}) } as any,
    ipcBridge: { waitForReady: async () => {} } as any,
    preloadPath: path.join(process.cwd(), "qa/app-preload.cjs"),
    windowById: (id) => (id === rendererOwnerId ? shell : null),
    hasShellWindow: () => true,
    resolveIconDataUrl: async () => null,
    onBeforeOpened: async () => folderTabs,
    onOpened: () => {},
    onRouteChanged: async () => {},
    onCloseTab: async () => {},
    onState: () => {},
    onPresentation: (id, state) => {
      shell.webContents.send(IPC.appTabs.presentation, state);
      presentationEvents.emit(state.tabId);
    },
  });
  desktopAppRuntime = { appTabs: host };
  for (const tabId of ["qa-browser-A", "qa-browser-B"])
    await host.open({
      tabId,
      app: browserPackage,
      spaceId: "qa-space",
      folderId: "qa-folder",
      threadId: "qa-agent-thread",
      route: "/",
      initiator: "agent",
    } as any);
  const tabs = host.list();
  folderTabs.tabs.panes = tabs.map((tab) => ({
    id: tab.id,
    kind: "app",
    appId: tab.appId,
    appSpaceId: tab.spaceId,
    appSlug: tab.slug,
    appName: tab.name,
    appRoute: tab.route,
  }));
  ipcMain.handle("qa-seed", () => ({ folderTabs }));
  ipcMain.handle("qa-list", () => tabs);
  ipcMain.on(IPC.appTabs.trace, (event, value) =>
    traceAppTab(value.event, { ...value.details, rendererId: event.sender.id, tabId: value.tabId }),
  );
  ipcMain.handle(IPC.appTabs.claimActivation, async (event, requestId: unknown) => {
    requireShellAppTabs(event.sender.id);
    return typeof requestId === "string" && appTabActivation.claim(requestId, event.sender.id);
  });
  ipcMain.handle(
    IPC.appTabs.failActivation,
    async (event, requestId: unknown, message: unknown) => {
      requireShellAppTabs(event.sender.id);
      if (typeof requestId !== "string" || typeof message !== "string")
        throw new Error("Invalid App tab activation failure.");
      appTabActivation.fail(requestId, event.sender.id, message);
    },
  );
  ipcMain.handle(IPC.appTabs.present, async (event, input: unknown) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) return;
    const { tabId, folderId, threadId, animate, animationStartedAtEpochMs, bounds } =
      input as Record<string, unknown>;
    if (
      typeof tabId !== "string" ||
      typeof folderId !== "string" ||
      typeof threadId !== "string" ||
      !bounds ||
      typeof bounds !== "object" ||
      Array.isArray(bounds)
    ) {
      throw new Error("Invalid App view presentation request.");
    }
    requireShellAppTabs(event.sender.id);
    const appBounds = bounds as Electron.Rectangle;
    traceAppTab("shell-present-ipc", {
      tabId,
      rendererId: event.sender.id,
      folderId,
      threadId,
      animate: animate === true,
      bounds: appBounds,
    });
    await presentAppTabInWindow({
      tabId,
      folderId,
      threadId,
      windowId: event.sender.id,
      bounds: appBounds,
      animate: animate === true,
      ...(typeof animationStartedAtEpochMs === "number" &&
      Number.isFinite(animationStartedAtEpochMs)
        ? { animationStartedAtEpochMs }
        : {}),
    });
    if (desktopAppRuntime?.appTabs.isVisible(tabId))
      appTabActivation.presented(tabId, event.sender.id);
  });
  ipcMain.handle(IPC.appTabs.hide, async (event, input: unknown) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) return;
    const { tabId, animate } = input as Record<string, unknown>;
    if (typeof tabId !== "string") return;
    if (animate !== undefined && typeof animate !== "boolean") return;
    const tabs = requireShellAppTabs(event.sender.id);
    if (tabs.has(tabId)) {
      traceAppTab("shell-hide-ipc", {
        tabId,
        rendererId: event.sender.id,
        animate: animate === true,
      });
      await hideAppTabInWindow(tabId, event.sender.id, animate === true);
    }
  });

  let rendererReady = false;
  ipcMain.on("qa-ready", () => (rendererReady = true));
  shell.webContents.on("console-message", (_event, level, message) =>
    diagnostic("renderer-console", { level, message }),
  );
  await shell.loadURL("http://127.0.0.1:5919/qa.html");
  await waitUntil(() => rendererReady, "renderer ready", 90000);
  await pause(500);
  for (const tab of tabs)
    shell.webContents.send(IPC.appTabs.opened, {
      ...tab,
      selection: "preserve",
      initiator: "agent",
    });
  await pause(700);
  await host.openHostedPage("qa-browser-A", "http://127.0.0.1:3919/probe");
  const page = host.target("qa-browser-A", "d2");
  const originalCdpSend = page.debugger.sendCommand.bind(page.debugger);
  (page.debugger as any).sendCommand = (method: string, params: any, sessionId: any) => {
    if (
      ["DOM.setFileInputFiles", "Input.dispatchMouseEvent", "Runtime.callFunctionOn"].includes(
        method,
      )
    )
      console.info("[qa-cdp-request]", { method, params, sessionId });
    return originalCdpSend(method, params, sessionId);
  };
  page.on("console-message", (event: any, level?: any, message?: any) => {
    const text = event.message ?? message ?? "";
    if (text.startsWith("QA_PAGE_EVENT ")) {
      const row = JSON.parse(text.slice(14));
      console.info("[qa-page-event]", row);
    }
  });
  const observer = new AppTabObserver({
    resolve: (tabId, document, surfaceId) => {
      const descriptor = host.list().find((row) => row.id === tabId);
      if (!descriptor)
        throw Object.assign(new Error(`App tab ${tabId} is gone.`), { code: "TAB_GONE" });
      return {
        descriptor,
        document,
        webContents: host.target(tabId, document),
        isPresented: () =>
          surfaceId !== null &&
          shell.isVisible() &&
          !shell.isMinimized() &&
          host.ownerWindowId(tabId) === rendererOwnerId &&
          host.isVisible(tabId),
        onPresentationChange: (listener) => {
          presentationEvents.on(tabId, listener);
          return () => presentationEvents.off(tabId, listener);
        },
        canDeliverPointerInput: () => host.canDeliverPointerInput(tabId),
      };
    },
    validateUploadPaths: async (_descriptor, paths) =>
      Promise.all(
        paths.map((file) => resolveBrowserUploadFile(file, path.join(qaRoot, "app-storage"))),
      ),
  });
  const commandServer = new AppCommandPipeServer({
    path: path.join(qaRoot, "qa-home", "commands.sock"),
    token: "qa-fixture-command-token",
    catalog: {} as any,
    broker: {} as any,
    tabs: host,
    activate: activateAppTabForAgent,
    presentation: appTabAgentPresentation,
    observationSurface: () => rendererOwnerId,
    observer,
    providerCredentialVault: {} as any,
  });
  await commandServer.start();
  const context = {
    spaceId: "qa-space",
    folderId: "qa-folder",
    threadId: "qa-agent-thread",
    callerTurnId: "qa-turn",
    cwd: path.join(qaRoot, "evidence"),
  };
  const results: any[] = [];
  async function execute(command: string, id: string, overrideContext: any = context) {
    const startedEpochMs = Date.now(),
      started = performance.now();
    diagnostic("command-sent", { command, id, startedEpochMs });
    const response = await executePenkraExecCommand(
      { command },
      overrideContext,
      commandServer.environment,
    ).then(
      (result) => ({ ok: true, result }),
      (error) => ({
        ok: false,
        error: {
          message: error.message,
          code: error.code,
          dispatched: error.dispatched,
          outcome: error.outcome,
          failedStep: error.failedStep,
          completedSteps: error.completedSteps,
        },
      }),
    );
    const row = {
      caseId,
      id,
      command,
      startedEpochMs,
      durationMs: performance.now() - started,
      ...response,
    };
    results.push(row);
    fs.writeFileSync(
      path.join(qaRoot, "evidence", "command-results.json"),
      JSON.stringify(results, null, 2),
    );
    diagnostic("command-result", row);
    return row;
  }
  const pageState = () => page.executeJavaScript("window.qaState()", false);
  async function show() {
    app.show();
    shell.restore();
    shell.show();
    await waitUntil(() => shell.isVisible() && !shell.isMinimized(), "visible");
    await host.setWindowVisibility(rendererOwnerId, true);
    await shell.webContents.executeJavaScript('window.qa.setup("qa-browser-A",true)');
    await host.presentInWindow({
      tabId: "qa-browser-A",
      folderId: "qa-folder",
      threadId: "qa-agent-thread",
      windowId: rendererOwnerId,
      bounds: { x: 650, y: 0, width: 550, height: 800 },
      animate: false,
    });
    await pause(300);
  }
  async function setMode(mode: string, throttling: boolean) {
    await show();
    for (const contents of webContents.getAllWebContents())
      if (!contents.isDestroyed()) contents.setBackgroundThrottling(throttling);
    if (mode === "hidden") shell.hide();
    if (mode === "minimized") shell.minimize();
    if (mode !== "visible")
      await waitUntil(
        () => !shell.isVisible() || (mode === "minimized" && shell.isMinimized()),
        mode,
      );
    await pause(500);
    return {
      mode,
      shellVisible: shell.isVisible(),
      minimized: shell.isMinimized(),
      hostVisible: host.isVisible("qa-browser-A"),
      pageVisibility: await page.executeJavaScript("document.visibilityState"),
      throttling: webContents
        .getAllWebContents()
        .map((c) => ({ id: c.id, value: c.getBackgroundThrottling() })),
    };
  }

  const coverShell = new BrowserWindow({
    width: 1208,
    height: 808,
    show: false,
    webPreferences: {
      preload: path.join(process.cwd(), "qa/preload.cjs"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  await coverShell.loadURL("http://127.0.0.1:5919/qa.html");
  coverShell.setTitle("Penkra QA second shell");
  shell.setTitle("Penkra QA target shell");
  const targetRect = { x: 50, y: 60, width: 1200, height: 800 };
  shell.setBounds(targetRect, false);
  const measurements: any[] = [];
  let targetWindowId: number | null = null;
  async function helper(action: string, bounds: any = {}) {
    const serial = Date.now();
    fs.writeFileSync(
      path.join(qaRoot, "helper-control.json"),
      JSON.stringify({ action, serial, ...bounds }),
    );
    if (action === "quit") {
      await pause(300);
      return helperState();
    }
    await waitUntil(() => {
      try {
        return (
          JSON.parse(fs.readFileSync(path.join(qaRoot, "helper-state.json"), "utf8")).serial ===
          serial
        );
      } catch {
        return false;
      }
    }, "helper acknowledgement");
    return JSON.parse(fs.readFileSync(path.join(qaRoot, "helper-state.json"), "utf8"));
  }
  const helperState = () =>
    JSON.parse(fs.readFileSync(path.join(qaRoot, "helper-state.json"), "utf8"));
  function geometry() {
    const run = spawnSync(
      "python3",
      ["qa/cg-window-list.py", String(process.pid), String(helperState().pid)],
      { encoding: "utf8" },
    );
    if (run.status !== 0) throw new Error("CG window metadata failed " + run.stderr);
    const data = JSON.parse(run.stdout);
    const eq = (b: any, r: any) =>
      Math.abs(b.X - r.x) < 1 &&
      Math.abs(b.Y - r.y) < 1 &&
      Math.abs(b.Width - r.width) < 1 &&
      Math.abs(b.Height - r.height) < 1;
    const target =
      data.windows.find((w: any) =>
        targetWindowId !== null
          ? w.windowId === targetWindowId
          : w.pid === process.pid && w.layer === 0 && eq(w.bounds, targetRect),
      ) ?? null;
    if (target && targetWindowId === null) targetWindowId = target.windowId;
    return { ...data, targetWindow: target };
  }
  async function sample() {
    return {
      epochMs: Date.now(),
      monotonicMs: performance.now(),
      shellVisible: shell.isVisible(),
      shellMinimized: shell.isMinimized(),
      shellBounds: shell.getBounds(),
      shellDocument: await shell.webContents.executeJavaScript(
        "({visibility:document.visibilityState,focus:document.hasFocus()})",
        false,
      ),
      pageDocument: await page.executeJavaScript(
        "({visibility:document.visibilityState,focus:document.hasFocus()})",
        false,
      ),
      nativeTabVisible: host.isVisible("qa-browser-A"),
      nativeOwner: host.ownerWindowId("qa-browser-A"),
      shellChildViews: shell.contentView.children.map((v) => ({
        id: (v as any).webContents?.id ?? null,
        visible: v.getVisible(),
      })),
      pageWebContentsId: page.id,
      helper: helperState(),
      geometry: geometry(),
    };
  }
  async function reset() {
    caseId = "h-reset";
    coverShell.hide();
    await helper("hide");
    await show();
    shell.setBounds(targetRect, false);
    app.focus({ steal: true });
    shell.moveTop();
    shell.focus();
    await pause(1200);
    await waitUntil(
      async () => {
        const s = await sample();
        const b = s.geometry.targetWindow?.bounds;
        return (
          s.shellDocument.visibility === "visible" &&
          s.nativeTabVisible &&
          b &&
          Math.abs(b.X - targetRect.x) < 1 &&
          Math.abs(b.Y - targetRect.y) < 1
        );
      },
      "uncovered live target baseline",
      30000,
    );
  }
  async function observed(
    name: string,
    owner: "shell" | "app" | "none",
    extent: "full" | "partial" | "none",
  ) {
    await reset();
    caseId = name;
    const before = await sample();
    diagnostic("cover-action-started", { name, owner, extent, before });
    const startEpochMs = Date.now();
    let rect: any = null;
    if (extent === "full")
      rect = {
        x: targetRect.x - 4,
        y: targetRect.y - 4,
        width: targetRect.width + 8,
        height: targetRect.height + 8,
      };
    if (extent === "partial")
      rect = {
        x: targetRect.x + targetRect.width / 2,
        y: targetRect.y - 4,
        width: targetRect.width / 2 + 4,
        height: targetRect.height + 8,
      };
    if (owner === "shell") {
      coverShell.setBounds(rect, false);
      coverShell.show();
      coverShell.moveTop();
      coverShell.focus();
    }
    if (owner === "app") {
      const display = screen.getPrimaryDisplay().bounds;
      await helper("show", {
        x: rect.x,
        y: display.y + display.height - rect.y - rect.height,
        width: rect.width,
        height: rect.height,
      });
    }
    const covered: any[] = [];
    for (let i = 0; i < 12; i++) {
      covered.push(await sample());
      await pause(200);
    }
    diagnostic("cover-removal-started", { owner });
    if (owner === "shell") coverShell.hide();
    if (owner === "app") await helper("hide");
    const uncovered: any[] = [];
    for (let i = 0; i < 6; i++) {
      uncovered.push(await sample());
      await pause(200);
    }
    const row = {
      caseId: name,
      owner,
      extent,
      startEpochMs,
      durationMs: Date.now() - startEpochMs,
      expectedCoverBounds: rect,
      before,
      covered,
      uncovered,
    };
    measurements.push(row);
    fs.writeFileSync(
      path.join(qaRoot, "evidence", "coverage-results.json"),
      JSON.stringify(measurements, null, 2),
    );
    diagnostic("cover-action-finished", row);
  }
  await observed("h-uncovered-control", "none", "none");
  await observed("h-shell-partial", "shell", "partial");
  await observed("h-shell-full", "shell", "full");
  await observed("h-other-app-partial", "app", "partial");
  await observed("h-other-app-full", "app", "full");
  await helper("quit");
  coverShell.destroy();
  caseId = "cleanup";
  observer.dispose?.();
  host.closeAll();
  await commandServer.dispose();
  fixtureServer.closeAllConnections();
  await new Promise<void>((r) => fixtureServer.close(() => r()));
  shell.destroy();
  app.exit(0);
}
run().catch((error) => {
  console.error(error);
  fs.writeFileSync(path.join(qaRoot, "evidence", "failure.txt"), error.stack ?? String(error));
  app.exit(1);
});
