// FILE: appTestHost.ts
// Purpose: Runs one unpacked App in the real isolated Electron runtime for `penkra app test`.
// Layer: Trusted desktop developer harness

import * as FS from "node:fs/promises";
import * as Path from "node:path";

import { FolderId } from "@penkra/contracts";

import { app, BrowserWindow, ipcMain, protocol } from "electron";

import { startDesktopAppRuntime } from "./desktopAppRuntime";
import { bootstrapDevelopmentSideload } from "./developmentAppSideload";
import { PENKRA_APP_SCHEME } from "./appRuntimePolicy";
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

async function run(): Promise<void> {
  let result: Record<string, unknown> = {
    ok: false,
    error: "The App integration host did not produce a result.",
    profilePath,
  };
  let runtime: Awaited<ReturnType<typeof startDesktopAppRuntime>> | undefined;
  let window: BrowserWindow | undefined;
  try {
    await runHostPhase("electron-ready", () => app.whenReady());
    window = new BrowserWindow({ show: false, width: 800, height: 600 });
    const startedRuntime = await runHostPhase("runtime-start", () =>
      startDesktopAppRuntime({
        resolveFolderTitle: async () => "App test",
        userDataPath: profilePath,
        accountServiceUrl: "https://app-test.invalid",
        appPreloadPath: Path.join(__dirname, "appPreload.js"),
        appControllerRunnerPath: Path.join(__dirname, "appNodeControllerRunner.js"),
        ipcMain,
        onBeforeTabOpened: async (tab) => ({
          folderId: FolderId.make(tab.folderId),
          folderTitle: "App test",
          updatedAt: new Date().toISOString(),
          tabs: {
            panes: [
              {
                id: tab.id,
                kind: "app",
                appId: tab.appId,
                appSpaceId: tab.spaceId,
                appSlug: tab.slug,
                appName: tab.name,
                appRoute: tab.route,
              },
            ],
          },
        }),
        onTabRouteChanged: async () => undefined,
        onTabPresentationChanged: async () => undefined,
        onCloseTab: async () => true,
        onTabOpened: () => undefined,
        onTabState: () => undefined,
        onTabClosed: () => undefined,
        getAccountId: async () => "app-test-account",
      }),
    );
    runtime = startedRuntime;
    {
      const runtime = startedRuntime;
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
          folderId: `folder:${TEST_THREAD_ID}`,
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
    }
  } catch (error) {
    result = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      profilePath,
    };
    process.exitCode = 1;
  } finally {
    if (runtime) await runHostPhase("runtime-stop", () => runtime!.stop()).catch(() => undefined);
    try {
      await runHostPhase(
        result.ok === true ? "success-evidence-write" : "failure-evidence-write",
        async () => {
          const temporary = `${resultPath}.tmp`;
          const file = await FS.open(temporary, "w", 0o600);
          try {
            await file.writeFile(`${JSON.stringify(result, null, 2)}\n`, "utf8");
            await file.sync();
          } finally {
            await file.close();
          }
          await FS.rename(temporary, resultPath);
        },
      );
    } catch {
      process.exitCode = 1;
    }
    window?.destroy();
    process.exit(typeof process.exitCode === "number" ? process.exitCode : 0);
  }
}

void run();

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return Path.resolve(value);
}

async function runHostPhase<T>(phase: string, run: () => Promise<T> | T): Promise<T> {
  hostDiagnostics.write(`[penkra-app-test] phase=${phase} state=start\n`);
  try {
    const result = await run();
    hostDiagnostics.write(`[penkra-app-test] phase=${phase} state=complete\n`);
    return result;
  } catch (error) {
    hostDiagnostics.write(
      `[penkra-app-test] phase=${phase} state=failed error=${JSON.stringify(error instanceof Error ? error.message : String(error))}\n`,
    );
    throw error;
  }
}
