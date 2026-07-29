// FILE: penkra-dev-launcher.test.ts
// Purpose: Verifies stable paths and process ownership checks for the Applications launcher.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  isExpectedPenkraDevSupervisorCommand,
  resolvePenkraDevLauncherPaths,
  resolvePenkraDevWorkspaceCommand,
  shouldRunPenkraDevLauncher,
} from "./penkra-dev-launcher";
import {
  parseAppleDevelopmentIdentity,
  resolvePenkraDevLauncherCompileArgs,
} from "./install-penkra-dev-app";
import { resolvePenkraDevIconSource } from "./lib/macos-icon";

describe("Penkra Dev launcher", () => {
  it("keeps launcher state and development data outside production Penkra", () => {
    const paths = resolvePenkraDevLauncherPaths("/Users/tester");

    expect(paths.stateDirectory).toBe("/Users/tester/Penkra_Dev/.launcher");
    expect(paths.developmentRoot).toBe("/Users/tester/Penkra_Dev");
    expect(paths.lockDirectory).toBe(`${paths.stateDirectory}/supervisor.lock`);
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
      resolvePenkraDevWorkspaceCommand(
        "/usr/local/bin/node",
        "/workspace/backend/ops/dev-workspace.mjs",
      ),
    ).toEqual({
      executable: "/usr/local/bin/node",
      args: ["/workspace/backend/ops/dev-workspace.mjs"],
      cwd: "/workspace",
    });
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

  it("passes local platform identity through Turbo to Electron", () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const turboConfig = JSON.parse(readFileSync(resolve(repoRoot, "turbo.json"), "utf8")) as {
      globalEnv?: string[];
    };

    expect(turboConfig.globalEnv).toEqual(
      expect.arrayContaining(["PENKRA_API_URL", "PENKRA_DEV_SUPERVISOR_PID", "PENKRA_ROOT"]),
    );
  });

  it("uses Penkra artwork for both development launchers", () => {
    expect(resolvePenkraDevIconSource("/workspace")).toBe(
      "/workspace/apps/desktop/resources/icon.png",
    );
  });

});
