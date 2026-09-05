// This function is serialized into Playwright's Electron evaluator. That context
// has neither a global require nor a dynamic-import callback.
export function configureNativeUpgradeFeed(
  { app }: { app: { getAppPath(): string } },
  url: string,
): void {
  const mainModule = process.mainModule;
  if (!mainModule) throw new Error("Packaged Electron main module is unavailable.");
  const requireApp = mainModule
    .require("node:module")
    .createRequire(`${app.getAppPath()}/package.json`);
  requireApp("electron-updater").autoUpdater.setFeedURL({
    provider: "generic",
    url,
    useMultipleRangeRequest: false,
  });
}
