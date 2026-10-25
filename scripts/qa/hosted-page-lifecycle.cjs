// Bundle with Bun (external electron), then run in the repository's Electron.
// The only profile argument must be an absolute task-specific scratch path.
const { app, BrowserWindow, webContents } = require("electron");
const http = require("node:http");
const path = require("node:path");
const assert = require("node:assert/strict");
const { AppTabViewHost } = require("../../apps/desktop/src/appTabViewHost.ts");
const profile = process.argv[2];
assert(profile && path.isAbsolute(profile), "Supply an absolute isolated scratch profile");
app.setPath("userData", profile);
const disposalCounts = new Map();
const info = console.info;
console.info = (label, entry) => {
  if (label !== "[app-tab-host]") return info(label, entry);
  if (entry.event === "hosted-page-dispose") {
    disposalCounts.set(entry.rendererId, (disposalCounts.get(entry.rendererId) ?? 0) + 1);
  }
};
let host;
let server;
process.once("uncaughtException", (error) => {
  console.error("NATIVE LIFECYCLE FAILURE", error);
  app.exit(1);
});
app.on("session-created", (partition) => {
  partition.protocol.handle("penkra-app", () => new Response("<title>QA app document</title>"));
});

function destroyed(contents) {
  return contents.isDestroyed()
    ? Promise.resolve()
    : new Promise((resolve) => contents.once("destroyed", resolve));
}

async function closeContents(contents) {
  const closed = destroyed(contents);
  if (contents.isDestroyed()) return;
  contents.close({ waitForBeforeUnload: false });
  await closed;
}

async function popup(opener, url) {
  const ready = new Promise((resolve) => {
    app.once("web-contents-created", (_event, contents) => {
      contents.once("did-finish-load", () => resolve(contents));
    });
  });
  await opener.executeJavaScript(
    `window.open(${JSON.stringify(url)}, '_blank', 'width=300,height=300'); undefined`,
    true,
  );
  return ready;
}

app
  .whenReady()
  .then(async () => {
    app.dock?.hide();
    server = http.createServer((_req, res) =>
      res.end("<title>QA hosted page</title>Local popup fixture"),
    );
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const windows = [];
    host = new AppTabViewHost({
      installations: {},
      sessions: { get: () => ({ origin: "penkra-app://a-" + "a".repeat(64) }) },
      broker: { registerTab: () => () => {} },
      rpc: { registerTarget: () => () => {}, request: async () => null },
      ipcBridge: { waitForReady: async () => {} },
      preloadPath: path.resolve("scripts/qa/fixtures/hosted-page-preload.cjs"),
      windowById: (id) => BrowserWindow.fromId(id),
      hasShellWindow: () => true,
      onBeforeOpened: async () => ({}),
      onOpened: () => {},
      onRouteChanged: async () => {},
      onPresentationChanged: async () => {},
      onCloseTab: async () => true,
      onState: () => {},
      resolveIconDataUrl: async () => null,
    });
    async function open(suffix, shellOwned) {
      const tab = await host.open({
        app: {
          appId: "com.penkra.browser",
          name: "QA browser",
          manifest: { entrypoints: { tab: "app.html" } },
        },
        spaceId: "qa-space",
        folderId: "qa-folder",
        threadId: "qa-thread",
        route: "/",
      });
      await host.openHostedPage(tab.id, origin + "/" + suffix);
      const contents = webContents
        .getAllWebContents()
        .find((c) => c.getURL() === origin + "/" + suffix);
      assert(contents);
      if (shellOwned) {
        const window = new BrowserWindow({ show: false, width: 800, height: 700 });
        windows.push(window);
        host.present(tab.id, window.id, { x: 0, y: 0, width: 600, height: 700 });
      }
      return { tab, contents };
    }
    const peer = await open("peer", true);
    const results = [];
    for (const shellOwned of [false, true]) {
      for (const scenario of ["nested", "opener-closed", "retire", "root-closed"]) {
        const { tab, contents: opener } = await open(`${shellOwned}-${scenario}`, shellOwned);
        if (scenario === "root-closed") {
          await closeContents(opener);
          assert.equal(host.hostedPageState(tab.id).open, false);
        } else {
          const first = await popup(opener, origin + "/first");
          if (scenario === "nested") {
            const second = await popup(first, origin + "/second");
            await closeContents(second);
            assert.equal(host.hostedPageState(tab.id).page.url, origin + "/first");
            await closeContents(first);
            assert.equal(host.hostedPageState(tab.id).page.url, opener.getURL());
            assert.equal(opener.isDestroyed(), false);
          } else if (scenario === "opener-closed") {
            await closeContents(opener);
            assert.equal(first.isDestroyed(), false);
            await closeContents(first);
            assert.equal(host.hostedPageState(tab.id).open, false);
          } else {
            const ended = Promise.all([destroyed(first), destroyed(opener)]);
            host.retireRenderer(tab.id, "host-stopped");
            await ended;
            assert.equal(first.isDestroyed(), true);
            assert.equal(opener.isDestroyed(), true);
          }
        }
        if (scenario !== "retire") {
          host.closeHostedPage(tab.id);
          host.closeHostedPage(tab.id);
        }
        host.retireRenderer(tab.id, "host-stopped");
        host.retireRenderer(tab.id, "host-stopped");
        assert.equal(peer.contents.isDestroyed(), false);
        assert.equal(host.hostedPageState(peer.tab.id).open, true);
        results.push({ shellOwned, scenario, passed: true });
      }
    }
    host.closeAll();
    for (const [id, count] of disposalCounts)
      assert.equal(count, 1, `Renderer ${id} disposed ${count} times`);
    // One peer plus eight hosted pages per shell-ownership mode.
    assert.equal(disposalCounts.size, 17);
    for (const window of windows) if (!window.isDestroyed()) window.destroy();
    await new Promise((resolve) => server.close(resolve));
    console.log(
      JSON.stringify({
        electron: process.versions.electron,
        cases: results,
        disposedExactlyOnce: disposalCounts.size,
      }),
    );
    app.quit();
  })
  .catch((error) => {
    console.error("NATIVE QA FAILURE", error);
    server?.close();
    app.exit(1);
  });
