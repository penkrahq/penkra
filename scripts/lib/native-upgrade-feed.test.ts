import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { configureNativeUpgradeFeed } from "./native-upgrade-feed";

describe("native updater feed evaluation", () => {
  it("loads the packaged updater without evaluator require or dynamic imports", () => {
    const setFeedURL = vi.fn();
    const requireApp = vi.fn(() => ({ autoUpdater: { setFeedURL } }));
    const createRequire = vi.fn(() => requireApp);
    const requireModule = vi.fn(() => ({ createRequire }));
    runInNewContext(`(${configureNativeUpgradeFeed.toString()})(electron, feed)`, {
      electron: { app: { getAppPath: () => "/package/app.asar" } },
      feed: "http://127.0.0.1:32123",
      process: { mainModule: { require: requireModule } },
    });
    expect(requireModule).toHaveBeenCalledWith("node:module");
    expect(createRequire).toHaveBeenCalledWith("/package/app.asar/package.json");
    expect(requireApp).toHaveBeenCalledWith("electron-updater");
    expect(setFeedURL).toHaveBeenCalledWith({
      provider: "generic",
      url: "http://127.0.0.1:32123",
      useMultipleRangeRequest: false,
    });
  });

  it("fails closed when the evaluator has no main module", () => {
    expect(() =>
      runInNewContext(`(${configureNativeUpgradeFeed.toString()})(electron, feed)`, {
        electron: { app: { getAppPath: () => "/package/app.asar" } },
        feed: "http://127.0.0.1:32123",
        process: {},
      }),
    ).toThrow();
  });

  it("captures replacement output without changing its executable, arguments or environment", () => {
    const spawnLog = vi.fn();
    const updater = { setFeedURL: vi.fn(), spawnLog };
    const openSync = vi.fn(() => 42);
    const requireApp = (name: string) =>
      name === "electron-updater" ? { autoUpdater: updater } : { openSync };
    runInNewContext(`(${configureNativeUpgradeFeed.toString()})(electron, feed)`, {
      electron: { app: { getAppPath: () => "/package/app.asar" } },
      feed: { url: "http://127.0.0.1:32123", launchLog: "/owned/relaunch.log" },
      process: { mainModule: { require: () => ({ createRequire: () => requireApp }) } },
    });
    const env = { OWNED: "value" };
    updater.spawnLog("/owned/Penkra.AppImage", [], env);
    expect(openSync).toHaveBeenCalledWith("/owned/relaunch.log", "a");
    expect(spawnLog).toHaveBeenCalledWith("/owned/Penkra.AppImage", [], env, ["ignore", 42, 42]);
    expect(spawnLog.mock.instances[0]).toBe(updater);
  });
});
