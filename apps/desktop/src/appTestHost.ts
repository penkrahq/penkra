// FILE: appTestHost.ts
// Purpose: Runs one unpacked App in the real isolated Electron runtime for `penkra app test`.
// Layer: Trusted desktop developer harness

import * as FS from "node:fs/promises";
import * as Path from "node:path";

import { app, BrowserWindow, ipcMain, protocol } from "electron";

import { startDesktopAppRuntime } from "./desktopAppRuntime";
import { bootstrapDevelopmentSideload } from "./developmentAppSideload";
import { PENKRA_APP_SCHEME } from "./appRuntimePolicy";
import { withAppTestPhaseTimeout } from "./appTestHostPhases";
import { createAppTestHostDiagnosticWriter } from "./appTestHostDiagnostics";

const sourcePath = requiredEnvironment("PENKRA_APP_TEST_SOURCE");
const profilePath = requiredEnvironment("PENKRA_APP_TEST_PROFILE");
const resultPath = requiredEnvironment("PENKRA_APP_TEST_RESULT");
const TEST_SPACE_ID = "app-test-space";
const TEST_THREAD_ID = "app-test-thread";
const hostDiagnostics = createAppTestHostDiagnosticWriter(process.stderr);

// The disposable test profile must not prompt for or block on the operator's
// real OS keychain. This still exercises Electron safeStorage through
// Chromium's purpose-built test keychain, matching the desktop smoke host.
app.commandLine.appendSwitch("use-mock-keychain");
app.setPath("userData", profilePath);
protocol.registerSchemesAsPrivileged([
  {
    scheme: PENKRA_APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

void runHostPhase("electron-ready", () => app.whenReady())
  .then(async () => {
    const window = new BrowserWindow({ show: false, width: 800, height: 600 });
    const runtime = await runHostPhase("runtime-start", () =>
      startDesktopAppRuntime({
        userDataPath: profilePath,
        appPreloadPath: Path.join(__dirname, "appPreload.js"),
        appControllerRunnerPath: Path.join(__dirname, "appNodeControllerRunner.js"),
        ipcMain,
        onTabOpened: () => undefined,
        onTabState: () => undefined,
        onTabClosed: () => undefined,
        getAccountId: async () => "app-test-account",
      }),
    );
    let result: Record<string, unknown> = {
      ok: false,
      error: "The App integration host did not produce a result.",
      profilePath,
    };
    try {
      await runHostPhase("app-sideload", () =>
        bootstrapDevelopmentSideload(runtime, sourcePath, TEST_SPACE_ID),
      );
      const installed = Object.values(runtime.installations.snapshot().packagesByInstallationKey);
      if (installed.length !== 1)
        throw new Error(`Expected one sideloaded App, found ${installed.length}.`);
      const packageRecord = installed[0]!;
      await runHostPhase("installation-enable", async () => {
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
      });
      const help = await runHostPhase("agent-help-validate", async () => {
        await runtime.operationCatalog.help({
          spaceId: TEST_SPACE_ID,
          slug: packageRecord.manifest.slug,
        });
        const operations: string[] = [];
        for (const operation of packageRecord.manifest.operations ?? []) {
          await runtime.operationCatalog.help({
            spaceId: TEST_SPACE_ID,
            slug: packageRecord.manifest.slug,
            operation: operation.key,
          });
          operations.push(operation.key);
        }
        return { root: true as const, operations };
      });
      const openedTab = await runHostPhase("tab-open", () =>
        runtime.appTabs.openInstalled({
          appId: packageRecord.appId,
          spaceId: TEST_SPACE_ID,
          deckId: `deck:${TEST_THREAD_ID}`,
          threadId: TEST_THREAD_ID,
          route: "/",
        }),
      );
      runtime.appTabs.present(openedTab.id, window.id, { x: 0, y: 0, width: 800, height: 600 });
      const tab = runtime.appTabs.list().find((candidate) => candidate.id === openedTab.id);
      if (!tab || tab.status !== "ready") throw new Error("The App tab did not reach ready state.");
      const diagnostics = await runHostPhase("diagnostics-read", () =>
        runtime.diagnostics.list({
          appId: packageRecord.appId,
          spaceId: TEST_SPACE_ID,
        }),
      );
      result = {
        ok: true,
        appId: packageRecord.appId,
        version: packageRecord.version,
        help,
        tab,
        diagnostics,
        profilePath,
      };
    } catch (error) {
      result = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        profilePath,
      };
      process.exitCode = 1;
    } finally {
      await runHostPhase("runtime-stop", () => runtime.stop(), 5_000).catch(() => undefined);
      window.destroy();
      await runHostPhase(
        result.ok === true ? "success-evidence-write" : "failure-evidence-write",
        () =>
          FS.writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, {
            encoding: "utf8",
            mode: 0o600,
          }),
        2_000,
      );
      // runtime.stop has observed exact controller process and stdio closure,
      // and the result file is durable. Electron 40 app.exit() can return
      // without terminating when this disposable host is supervised by pipes,
      // so end the isolated process only after those cleanup receipts exist.
      process.exit(typeof process.exitCode === "number" ? process.exitCode : 0);
    }
  })
  .catch(async (error) => {
    await FS.writeFile(
      resultPath,
      `${JSON.stringify({ ok: false, error: String(error), profilePath }, null, 2)}\n`,
      { mode: 0o600 },
    ).catch(() => undefined);
    process.exit(1);
  });

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return Path.resolve(value);
}

async function runHostPhase<T>(
  phase: string,
  run: () => Promise<T> | T,
  timeoutMs?: number,
): Promise<T> {
  hostDiagnostics.write(`[penkra-app-test] phase=${phase} state=start\n`);
  try {
    const result = await withAppTestPhaseTimeout({
      phase,
      run,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    hostDiagnostics.write(`[penkra-app-test] phase=${phase} state=complete\n`);
    return result;
  } catch (error) {
    hostDiagnostics.write(
      `[penkra-app-test] phase=${phase} state=failed error=${JSON.stringify(error instanceof Error ? error.message : String(error))}\n`,
    );
    throw error;
  }
}
