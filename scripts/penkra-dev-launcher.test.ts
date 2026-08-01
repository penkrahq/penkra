// FILE: penkra-dev-launcher.test.ts
// Purpose: Verifies stable paths and process ownership checks for the Applications launcher.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  isExpectedPenkraDevSupervisorCommand,
  resolveOrphanedDesktopBackendPids,
  resolveOrphanedWorkspaceProcessRoots,
  resolvePenkraDevLauncherPaths,
  resolvePenkraDevWorkspaceCommand,
  shouldRunPenkraDevLauncher,
  waitForDevelopmentElectron,
  waitForDockerEngine,
} from "./penkra-dev-launcher";
import {
  makeInfoPlist,
  resolvePenkraDevLauncherSignArgs,
  parseAppleDevelopmentIdentity,
  resolvePenkraDevLauncherCompileArgs,
} from "./install-penkra-dev-app";
import { resolvePenkraDevIconSource } from "./lib/macos-icon";
import { APP_DATA_USAGE_DESCRIPTION } from "./lib/macos-privacy";
import { resolvePenkraDevWorkspaceConfigPath } from "./lib/penkra-dev-workspace";

describe("Penkra Dev launcher", () => {
  it("keeps launcher state and development data outside production Penkra", () => {
    const paths = resolvePenkraDevLauncherPaths("/Users/tester");

    expect(paths.stateDirectory).toBe("/Users/tester/Penkra_Dev/.launcher");
    expect(paths.developmentRoot).toBe("/Users/tester/Penkra_Dev");
    expect(paths.lockDirectory).toBe(`${paths.stateDirectory}/supervisor.lock`);
    expect(paths.statusPath).toBe(`${paths.stateDirectory}/status.json`);
    expect(paths.failurePath).toBe(`${paths.stateDirectory}/failure.json`);
  });

  it("does not open Docker Desktop when its engine is already ready", async () => {
    let startCount = 0;

    await expect(
      waitForDockerEngine({
        isReady: () => true,
        startDockerDesktop: () => {
          startCount += 1;
        },
        sleep: async () => {},
      }),
    ).resolves.toBe("already-ready");
    expect(startCount).toBe(0);
  });

  it("opens Docker Desktop once and waits for the engine", async () => {
    let checks = 0;
    let startCount = 0;

    await expect(
      waitForDockerEngine({
        isReady: () => {
          checks += 1;
          return checks >= 3;
        },
        startDockerDesktop: () => {
          startCount += 1;
        },
        sleep: async () => {},
        timeoutMs: 1_000,
        pollIntervalMs: 1,
      }),
    ).resolves.toBe("started");
    expect(startCount).toBe(1);
  });

  it("reports when Docker Desktop never becomes ready", async () => {
    let currentTime = 0;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => currentTime);
    try {
      await expect(
        waitForDockerEngine({
          isReady: () => false,
          startDockerDesktop: () => {},
          sleep: async (milliseconds) => {
            currentTime += milliseconds;
          },
          timeoutMs: 3_000,
          pollIntervalMs: 1_000,
        }),
      ).rejects.toThrow("Docker Desktop did not become ready within 3 seconds");
    } finally {
      dateNow.mockRestore();
    }
  });

  it("keeps monitoring for Electron throughout a live workspace startup", async () => {
    let checks = 0;
    let focusCount = 0;

    await expect(
      waitForDevelopmentElectron({
        isRunning: () => {
          checks += 1;
          return checks === 4;
        },
        onRunning: () => {
          focusCount += 1;
        },
        shouldContinue: () => true,
        sleep: async () => {},
        timeoutMs: null,
      }),
    ).resolves.toBe(true);
    expect(checks).toBe(4);
    expect(focusCount).toBe(1);
  });

  it("stops monitoring when the workspace exits before Electron starts", async () => {
    let workspaceActive = true;

    await expect(
      waitForDevelopmentElectron({
        isRunning: () => false,
        shouldContinue: () => workspaceActive,
        sleep: async () => {
          workspaceActive = false;
        },
        timeoutMs: null,
      }),
    ).resolves.toBe(false);
  });

  it("accepts only the configured detached supervisor command", () => {
    const scriptPath = "/workspace/scripts/penkra-dev-launcher.ts";

    expect(
      isExpectedPenkraDevSupervisorCommand(
        `/usr/local/bin/node ${scriptPath} supervise --bun /opt/homebrew/bin/bun`,
        scriptPath,
      ),
    ).toBe(true);
    expect(
      isExpectedPenkraDevSupervisorCommand(
        `/usr/local/bin/node ${scriptPath} launch --bun /opt/homebrew/bin/bun`,
        scriptPath,
      ),
    ).toBe(false);
    expect(
      isExpectedPenkraDevSupervisorCommand(
        "/usr/local/bin/node /other/scripts/penkra-dev-launcher.ts supervise",
        scriptPath,
      ),
    ).toBe(false);
  });

  it("delegates startup to the canonical full-workspace orchestrator", () => {
    expect(
      resolvePenkraDevWorkspaceCommand("/usr/local/bin/node", {
        desktopRoot: "/workspace/penkra",
        backendRoot: "/repositories/backend-checkout",
        websiteRoot: "/repositories/website-checkout",
      }),
    ).toEqual({
      executable: "/usr/local/bin/node",
      args: [
        "/repositories/backend-checkout/ops/dev-workspace.mjs",
        "--desktop-root",
        "/workspace/penkra",
        "--website-root",
        "/repositories/website-checkout",
      ],
      cwd: "/repositories/backend-checkout",
    });
  });

  it("reaps only reparented workspace process trees", () => {
    expect(
      resolveOrphanedWorkspaceProcessRoots(
        [
          { pid: 10, parentPid: 1, command: "node pnpm dev" },
          { pid: 11, parentPid: 10, command: "node /workspace/backend/src/server.ts" },
          { pid: 20, parentPid: 2, command: "node pnpm dev" },
          { pid: 21, parentPid: 20, command: "node /workspace/website/next dev" },
          { pid: 30, parentPid: 1, command: "node /unrelated/server.ts" },
        ],
        ["/workspace/backend", "/workspace/website"],
      ),
    ).toEqual([10]);
  });

  it("reaps only an orphaned embedded backend from the active desktop checkout", () => {
    const desktopRoot = "/workspace/penkra";
    const executable = `${desktopRoot}/apps/desktop/.electron-runtime/Penkra (Dev).app/Contents/MacOS/Penkra (Dev)`;
    const backendEntry = `${desktopRoot}/apps/server/dist/index.mjs`;

    expect(
      resolveOrphanedDesktopBackendPids(
        [
          {
            pid: 10,
            parentPid: 1,
            command: `${executable} --max-old-space-size=4096 ${backendEntry}`,
          },
          { pid: 11, parentPid: 9, command: `${executable} ${backendEntry}` },
          {
            pid: 12,
            parentPid: 1,
            command: `/Applications/Pen.app/Contents/MacOS/Pen ${desktopRoot}/penkra.pen`,
          },
          {
            pid: 13,
            parentPid: 1,
            command: `${executable} /other/checkout/apps/server/dist/index.mjs`,
          },
        ],
        desktopRoot,
      ),
    ).toEqual([10]);
  });

  it("keeps repository topology in local launcher state", () => {
    expect(resolvePenkraDevWorkspaceConfigPath("/Users/tester")).toBe(
      "/Users/tester/Penkra_Dev/.launcher/workspace.json",
    );
  });

  it("compiles a standalone launcher with its repository root embedded", () => {
    expect(
      resolvePenkraDevLauncherCompileArgs({
        bunExecutable: "/opt/homebrew/bin/bun",
        launcherScriptPath: "/workspace/scripts/penkra-dev-launcher.ts",
        executablePath: "/tmp/Penkra (Dev)",
        repoRoot: "/workspace",
      }),
    ).toEqual([
      "build",
      "--compile",
      "--minify",
      "--define",
      'PENKRA_DEV_REPO_ROOT="/workspace"',
      "--define",
      'PENKRA_DEV_BUN_EXECUTABLE="/opt/homebrew/bin/bun"',
      "/workspace/scripts/penkra-dev-launcher.ts",
      "--outfile",
      "/tmp/Penkra (Dev)",
    ]);
  });

  it("executes the compiled launcher even when Bun does not mark the bundle as main", () => {
    expect(
      shouldRunPenkraDevLauncher({
        compiledRepoRoot: "/workspace",
        importMetaMain: false,
        argvEntry: "launch",
        sourcePath: "/workspace/scripts/penkra-dev-launcher.ts",
      }),
    ).toBe(true);
  });

  it("prefers a stable Apple Development signing identity", () => {
    expect(
      parseAppleDevelopmentIdentity(
        '  1) ABC "Apple Development: Penkra Developer (TEAM123)"\n     1 valid identities found',
      ),
    ).toBe("Apple Development: Penkra Developer (TEAM123)");
    expect(parseAppleDevelopmentIdentity("0 valid identities found")).toBeNull();
  });

  it("explains intentional access to installed provider data", () => {
    expect(makeInfoPlist()).toContain(
      `<key>NSAppDataUsageDescription</key>\n  <string>${APP_DATA_USAGE_DESCRIPTION}</string>`,
    );
    expect(makeInfoPlist()).toContain("<key>NSMicrophoneUsageDescription</key>");
    expect(makeInfoPlist()).toContain("Penkra needs microphone access");
  });

  it("signs the launcher with the microphone entitlement", () => {
    expect(
      resolvePenkraDevLauncherSignArgs({
        entitlementsPath: "/repo/scripts/resources/penkra-dev-launcher.entitlements.plist",
        signingIdentity: "Apple Development: Developer (TEAM123)",
        stagedAppPath: "/tmp/Penkra (Dev).app",
      }),
    ).toEqual(
      expect.arrayContaining([
        "--options",
        "runtime",
        "--entitlements",
        "/repo/scripts/resources/penkra-dev-launcher.entitlements.plist",
      ]),
    );
  });

  it("passes local platform identity through Turbo to Electron", () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const turboConfig = JSON.parse(readFileSync(resolve(repoRoot, "turbo.json"), "utf8")) as {
      globalEnv?: string[];
    };

    expect(turboConfig.globalEnv).toEqual(
      expect.arrayContaining([
        "PENKRA_API_URL",
        "PENKRA_DEV_SUPERVISOR_PID",
        "PENKRA_ROOT",
        "PENKRA_SKIP_LOGIN_SHELL_ENVIRONMENT",
      ]),
    );
  });

  it("uses Penkra artwork for both development launchers", () => {
    expect(resolvePenkraDevIconSource("/workspace")).toBe(
      "/workspace/apps/desktop/resources/icon.png",
    );
  });
});
