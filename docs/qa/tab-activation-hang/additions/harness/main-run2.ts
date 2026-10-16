import { app, BrowserWindow, ipcMain, session, protocol } from "electron";
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
const backendHttpUrl = "http://127.0.0.1:3909";
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
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, result: folderTabs }));
  });
  await new Promise<void>((r) => fixtureServer.listen(3909, "127.0.0.1", r));
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
  await session
    .fromPartition(partition)
    .protocol.handle(
      "penkra-app",
      () =>
        new Response(
          "<html><body style='background:#fff'>Local Browser fixture; no network/account</body></html>",
          { headers: { "Content-Type": "text/html" } },
        ),
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
    onPresentation: (id, state) => shell.webContents.send(IPC.appTabs.presentation, state),
  });
  desktopAppRuntime = { appTabs: host };
  for (const tabId of ["qa-browser-A", "qa-browser-B"]) {
    await host.open({
      tabId,
      app: browserPackage,
      spaceId: "qa-space",
      folderId: "qa-folder",
      threadId: "qa-agent-thread",
      route: "/",
      initiator: "agent",
    } as any);
  }
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
  shell.webContents.on("console-message", (_e, level, message) =>
    diagnostic("renderer-console", { level, message }),
  );
  await shell.loadURL("http://127.0.0.1:5909/qa.html");
  await waitUntil(() => rendererReady, "renderer ready", 90000);
  await pause(500);
  for (const tab of tabs)
    shell.webContents.send(IPC.appTabs.opened, {
      ...tab,
      selection: "preserve",
      initiator: "agent",
    });
  await pause(700);
  const commandServer = new AppCommandPipeServer({
    path: path.join(qaRoot, "qa-home", "commands.sock"),
    token: "qa-fixture-command-token",
    catalog: {} as any,
    broker: {} as any,
    tabs: host,
    activate: activateAppTabForAgent,
    presentation: appTabAgentPresentation,
    observer: {} as any,
    providerCredentialVault: {} as any,
  });
  await commandServer.start();
  const results: any[] = [];
  const context = {
    spaceId: "qa-space",
    folderId: "qa-folder",
    threadId: "qa-agent-thread",
    callerTurnId: "qa-turn",
  };
  async function setup(active: string, open: boolean) {
    gate = null;
    claimGate = null;
    app.show();
    shell.restore();
    shell.show();
    await host.setWindowVisibility(rendererOwnerId, true);
    await shell.webContents.executeJavaScript(`window.qa.setup(${JSON.stringify(active)},${open})`);
    await pause(500);
    if (open && !host.isVisible(active))
      await host.presentInWindow({
        tabId: active,
        folderId: "qa-folder",
        threadId: "qa-agent-thread",
        windowId: rendererOwnerId,
        bounds: { x: 700, y: 0, width: 500, height: 800 },
        animate: false,
      });
    await pause(250);
  }
  async function snapshot() {
    return {
      renderer: await shell.webContents.executeJavaScript("window.qa.state()"),
      visible: host.isVisible("qa-browser-A"),
      ownerId: host.ownerWindowId("qa-browser-A"),
      windowVisible: shell.isVisible(),
      windowMinimized: shell.isMinimized(),
    };
  }
  for (const id of ["b-cmdh-after-claim", "b-cmdh-before-claim", "d-already-app-hidden"]) {
    caseId = id;
    await setup(id.startsWith("a-") ? "qa-browser-A" : "qa-browser-B", id !== "a-collapsed-active");
    if (id === "a-hidden-native-active")
      await host.hideInWindow("qa-browser-A", rendererOwnerId, false);
    if (id === "b-cmdh-after-claim") gate = makeGate();
    if (id === "b-cmdh-before-claim") claimGate = makeGate();
    if (id === "d-already-app-hidden") {
      app.hide();
      await pause(250);
    }
    const before = await snapshot();
    diagnostic("command-sent", {
      command: "penkra tabs activate --tab-id qa-browser-A",
      scope: context,
      before,
    });
    const started = performance.now();
    const command = executePenkraExecCommand(
      { command: "penkra tabs activate --tab-id qa-browser-A" },
      context,
      commandServer.environment,
    ).then(
      (result) => ({ ok: true, result }),
      (error) => ({
        ok: false,
        error: { message: error.message, code: error.code, dispatched: error.dispatched },
      }),
    );
    if (id.startsWith("b-")) {
      await waitUntil(() => {
        const lines = fs.readFileSync(logFile, "utf8").trim().split("\n");
        return lines.slice(-50).some((line) => {
          const row = JSON.parse(line);
          return (
            row.caseId === id &&
            row.details.event ===
              (id === "b-cmdh-before-claim" ? "activation-claim-gated" : "presentation-gated")
          );
        });
      }, "claimed + presentation gate");
      app.hide();
      await waitUntil(() => !shell.isVisible() || shell.isMinimized(), "window hidden/minimized");
      await pause(100);
      diagnostic("gate-released", {
        windowVisible: shell.isVisible(),
        windowMinimized: shell.isMinimized(),
      });
      if (id === "b-cmdh-before-claim") {
        claimGate.release();
        claimGate = null;
      } else {
        gate!.release();
        gate = null;
      }
    }
    const result = await command;
    const record = {
      caseId: id,
      durationMs: performance.now() - started,
      command: "penkra tabs activate --tab-id qa-browser-A",
      scope: context,
      before,
      ...result,
      after: await snapshot(),
    };
    results.push(record);
    fs.writeFileSync(
      path.join(qaRoot, "evidence", "results.json"),
      JSON.stringify(results, null, 2),
    );
    diagnostic("command-result", record);
    try {
      const image = await shell.webContents.capturePage();
      fs.writeFileSync(path.join(qaRoot, "evidence", id + ".png"), image.toPNG());
    } catch {}
    await pause(300);
  }
  caseId = "cleanup";
  host.closeAll();
  await commandServer.dispose();
  await new Promise<void>((r) => fixtureServer.close(() => r()));
  shell.destroy();
  app.quit();
}
run().catch((error) => {
  console.error(error);
  fs.writeFileSync(path.join(qaRoot, "evidence", "failure.txt"), error.stack ?? String(error));
  app.exit(1);
});
