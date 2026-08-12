// FILE: appTestHost.ts
// Purpose: Runs one unpacked App in the real isolated Electron runtime for `penkra app test`.
// Layer: Trusted desktop developer harness

import * as FS from "node:fs/promises";
import * as Path from "node:path";

import { app, BrowserWindow, ipcMain } from "electron";

import { startDesktopAppRuntime } from "./desktopAppRuntime";
import { bootstrapDevelopmentSideload } from "./developmentAppSideload";

const sourcePath = requiredEnvironment("PENKRA_APP_TEST_SOURCE");
const profilePath = requiredEnvironment("PENKRA_APP_TEST_PROFILE");
const resultPath = requiredEnvironment("PENKRA_APP_TEST_RESULT");
const TEST_SPACE_ID = "app-test-space";
const TEST_THREAD_ID = "app-test-thread";

// The disposable test profile must not prompt for or block on the operator's
// real OS keychain. This still exercises Electron safeStorage through
// Chromium's purpose-built test keychain, matching the desktop smoke host.
app.commandLine.appendSwitch("use-mock-keychain");
app.setPath("userData", profilePath);

void app
  .whenReady()
  .then(async () => {
    const window = new BrowserWindow({ show: false, width: 800, height: 600 });
    const runtime = await startDesktopAppRuntime({
      userDataPath: profilePath,
      appPreloadPath: Path.join(__dirname, "appPreload.js"),
      ipcMain,
      window: () => window,
      onTabOpened: () => undefined,
      onTabState: () => undefined,
      onTabClosed: () => undefined,
      getAccountId: async () => "app-test-account",
    });
    try {
      await bootstrapDevelopmentSideload(runtime, sourcePath, TEST_SPACE_ID);
      const installed = Object.values(runtime.installations.snapshot().packagesByInstallationKey);
      if (installed.length !== 1)
        throw new Error(`Expected one sideloaded App, found ${installed.length}.`);
      const packageRecord = installed[0]!;
      for (const permission of packageRecord.manifest.permissions ?? []) {
        await runtime.installations.setPermission({
          appId: packageRecord.appId,
          spaceId: TEST_SPACE_ID,
          permission: permission.name,
          grant: "granted",
        });
      }
      await runtime.installations.setEnabled({
        appId: packageRecord.appId,
        spaceId: TEST_SPACE_ID,
        enabled: true,
      });
      const tab = await runtime.appTabs.openInstalled({
        appId: packageRecord.appId,
        spaceId: TEST_SPACE_ID,
        threadId: TEST_THREAD_ID,
        route: "/",
      });
      const diagnostics = await runtime.diagnostics.list({
        appId: packageRecord.appId,
        spaceId: TEST_SPACE_ID,
      });
      await FS.writeFile(
        resultPath,
        `${JSON.stringify(
          {
            ok: true,
            appId: packageRecord.appId,
            version: packageRecord.version,
            tab,
            diagnostics,
            profilePath,
          },
          null,
          2,
        )}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    } catch (error) {
      await FS.writeFile(
        resultPath,
        `${JSON.stringify(
          {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            profilePath,
          },
          null,
          2,
        )}\n`,
        { encoding: "utf8", mode: 0o600 },
      ).catch(() => undefined);
      process.exitCode = 1;
    } finally {
      await runtime.stop().catch(() => undefined);
      window.destroy();
      app.quit();
    }
  })
  .catch(async (error) => {
    await FS.writeFile(
      resultPath,
      `${JSON.stringify({ ok: false, error: String(error), profilePath }, null, 2)}\n`,
      { mode: 0o600 },
    ).catch(() => undefined);
    app.exit(1);
  });

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return Path.resolve(value);
}
