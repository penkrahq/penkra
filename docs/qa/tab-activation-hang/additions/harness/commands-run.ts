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
  WINDOW_EVENTS;
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
  IPC_HANDLERS;
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
  const states: any[] = [];
  for (const mode of ["visible", "hidden", "minimized"])
    for (const throttling of [true, false])
      for (const bypass of mode === "visible" ? [false] : [false, true]) {
        caseId = `f-${mode}-throttle-${throttling}-bypass-${bypass}`;
        process.env.QA_BYPASS_TAB_GUARD = bypass ? "1" : "0";
        const before = await setMode(mode, throttling);
        await page.executeJavaScript(`window.qaReset(${JSON.stringify(caseId)})`);
        const snapshot = await execute(
          "penkra tabs snapshot --tab-id qa-browser-A --document d2",
          caseId + "-snapshot",
        );
        const refs: any = (snapshot as any).result?.refs ?? {};
        const find = (name: string) =>
          Object.entries(refs).find(([key, value]: any) => value.name === name)?.[0];
        const click = find("Click probe"),
          type = find("Text probe"),
          upload = find("Upload probe");
        if (!click || !type || !upload)
          throw new Error("QA missing references " + JSON.stringify(refs));
        const commandRows: any[] = [];
        for (const step of [
          { action: "click", ref: click },
          { action: "type", ref: type, text: "typed-" + caseId },
          { action: "scroll", document: "d2", deltaY: 400 },
          {
            action: "upload",
            ref: upload,
            paths: [path.join(qaRoot, "app-storage", "upload-fixture.txt")],
          },
        ]) {
          const actionId = `${caseId}-${step.action}`;
          await page.executeJavaScript(`window.qaCase=${JSON.stringify(actionId)}`);
          const row = await execute(
            `penkra tabs act --input '${JSON.stringify({ tabId: "qa-browser-A", steps: [step] })}'`,
            actionId,
          );
          const immediate = await pageState();
          await pause(1000);
          const delayed = await pageState();
          commandRows.push({ actionId, response: row, immediate, afterOneSecond: delayed });
        }
        await pause(3000);
        const beforeRestore = await pageState();
        const hiddenEnd = { visible: shell.isVisible(), minimized: shell.isMinimized() };
        await show();
        await pause(1000);
        const afterRestore = await pageState();
        const state = { caseId, before, commandRows, beforeRestore, hiddenEnd, afterRestore };
        states.push(state);
        fs.writeFileSync(
          path.join(qaRoot, "evidence", "event-delivery-matrix.json"),
          JSON.stringify(states, null, 2),
        );
      }
  caseId = "g-help";
  process.env.QA_BYPASS_TAB_GUARD = "0";
  await show();
  fs.mkdirSync(path.join(qaRoot, "evidence", "help"), { recursive: true });
  for (const sub of [
    "",
    "list",
    "activate",
    "close",
    "snapshot",
    "act",
    "evaluate",
    "screenshot",
    "record",
    "trace",
    "har",
  ]) {
    const command = `penkra tabs${sub ? " " + sub : ""} --help`;
    const row = await execute(command, "help-" + (sub || "root"));
    fs.writeFileSync(
      path.join(qaRoot, "evidence", "help", (sub || "root") + ".json"),
      JSON.stringify(row, null, 2),
    );
  }
  AUDIT_COMMANDS;
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
