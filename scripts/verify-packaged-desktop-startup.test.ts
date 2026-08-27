import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createPackagedDesktopSmokeEnvironment,
  extractPackagedDesktopBackendPort,
  findWindowsProcessesInsideRoot,
  formatWindowsProcessSurvivorError,
  inspectPackagedDesktopStartupLog,
  parsePackagedDesktopStartupArgs,
  parseWindowsProcessInventory,
  removePackagedDesktopSmokeRoot,
  resolvePackagedDesktopSmokeLogPath,
  resolvePackagedDesktopSmokePenkraRoot,
  resolveNativePackagedDesktopPlatform,
} from "./verify-packaged-desktop-startup.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("packaged desktop startup verification", () => {
  it("parses a bounded native payload request", () => {
    expect(
      parsePackagedDesktopStartupArgs([
        "--assets-dir",
        "./release-publish",
        "--platform",
        "linux",
        "--arch",
        "x64",
        "--version",
        "1.2.3",
      ]),
    ).toEqual({
      assetsDirectory: expect.stringMatching(/release-publish$/),
      platform: "linux",
      arch: "x64",
      version: "1.2.3",
      timeoutMs: 60_000,
    });

    expect(() =>
      parsePackagedDesktopStartupArgs([
        "--assets-dir",
        "./release-publish",
        "--platform",
        "linux",
        "--arch",
        "x64",
        "--version",
        "1.2.3",
        "--timeout-ms",
        "4999",
      ]),
    ).toThrow("--timeout-ms must be an integer between 5000 and 180000");
  });

  it("isolates user state and removes inherited runtime authority", () => {
    const root = mkdtempSync(join(tmpdir(), "penkra-packaged-smoke-env-test-"));
    temporaryRoots.push(root);

    const env = createPackagedDesktopSmokeEnvironment(
      root,
      { platform: "linux", version: "1.2.3" },
      {
        PATH: process.env.PATH,
        PENKRA_AUTH_TOKEN: "must-not-leak",
        ELECTRON_RUN_AS_NODE: "1",
      },
    );

    expect(env.PENKRA_AUTH_TOKEN).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    for (const name of [
      "HOME",
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA",
      "XDG_CONFIG_HOME",
      "XDG_CACHE_HOME",
      "XDG_DATA_HOME",
      "PENKRA_DESKTOP_SMOKE_USER_DATA",
    ] as const) {
      expect(env[name]?.startsWith(root)).toBe(true);
      expect(existsSync(env[name]!)).toBe(true);
    }
    expect(env.PENKRA_HOME).toBeUndefined();
    expect(
      JSON.parse(readFileSync(join(env.XDG_CONFIG_HOME!, "Penkra", "root.json"), "utf8")),
    ).toEqual({ root: resolvePackagedDesktopSmokePenkraRoot(root) });
    expect(resolvePackagedDesktopSmokeLogPath(root)).toBe(
      join(root, "penkra-root", ".penkra", "userdata", "logs", "desktop-main.log"),
    );
  });

  it("maps Node host platforms to release platform names", () => {
    expect(resolveNativePackagedDesktopPlatform("darwin")).toBe("mac");
    expect(resolveNativePackagedDesktopPlatform("win32")).toBe("win");
    expect(resolveNativePackagedDesktopPlatform("linux")).toBe("linux");
  });

  it("removes the isolated startup tree after process cleanup", () => {
    const root = mkdtempSync(join(tmpdir(), "penkra-packaged-smoke-cleanup-test-"));
    writeFileSync(join(root, "proof.txt"), "ready");

    removePackagedDesktopSmokeRoot(root);

    expect(existsSync(root)).toBe(false);
  });

  it("requires complete startup proof and rejects missing account-auth IPC", () => {
    expect(
      inspectPackagedDesktopStartupLog(
        [
          "app ready",
          "bootstrap main window created",
          "bootstrap backend ready source=http",
          "bootstrap required Apps package ready version=0.2.5 digest=sha256",
        ].join("\n"),
      ),
    ).toEqual({ failure: null, hasProof: true });

    expect(
      inspectPackagedDesktopStartupLog(
        ["app ready", "bootstrap main window created", "bootstrap backend ready source=http"].join(
          "\n",
        ),
      ),
    ).toEqual({ failure: null, hasProof: false });

    expect(
      inspectPackagedDesktopStartupLog(
        "Error: No handler registered for 'desktop:account-auth-get-state'",
      ),
    ).toEqual({
      failure: "Packaged desktop invoked account authentication before its IPC handler existed.",
      hasProof: false,
    });

    expect(
      inspectPackagedDesktopStartupLog(
        [
          "app ready",
          "bootstrap main window created",
          "bootstrap backend ready source=http",
          "bootstrap required Apps package ready version=0.2.5 digest=sha256",
          "fatal startup error stage=required Apps message=controller exited",
        ].join("\n"),
      ),
    ).toEqual({
      failure:
        "Packaged desktop reported a fatal startup error: required Apps message=controller exited",
      hasProof: false,
    });
  });

  it("extracts only a valid reserved backend port from the desktop log", () => {
    expect(
      extractPackagedDesktopBackendPort("[desktop] bootstrap resolved backend endpoint port=64748"),
    ).toBe(64748);
    expect(extractPackagedDesktopBackendPort("port=0")).toBeNull();
    expect(
      extractPackagedDesktopBackendPort("bootstrap resolved backend endpoint port=99999"),
    ).toBeNull();
  });
});

describe("Windows packaged desktop process inventory", () => {
  const temporaryRoot = "C:\\Users\\runner admin\\AppData\\Local\\Temp\\penkra smoke root";

  it("parses PowerShell process JSON including paths with spaces", () => {
    expect(
      parseWindowsProcessInventory(
        JSON.stringify([
          {
            ProcessId: 41,
            ExecutablePath: `${temporaryRoot}\\application\\Penkra.exe`,
            CommandLine: `"${temporaryRoot}\\application\\Penkra.exe" --flag`,
          },
          { ProcessId: 42, ExecutablePath: null, CommandLine: null },
        ]),
      ),
    ).toEqual([
      {
        processId: 41,
        executablePath: `${temporaryRoot}\\application\\Penkra.exe`,
        commandLine: `"${temporaryRoot}\\application\\Penkra.exe" --flag`,
      },
      { processId: 42, executablePath: null, commandLine: null },
    ]);
    expect(parseWindowsProcessInventory("[]")).toEqual([]);
  });

  it("matches executable paths inside the root case-insensitively", () => {
    const inventory = parseWindowsProcessInventory(
      JSON.stringify([
        {
          ProcessId: 51,
          ExecutablePath: `${temporaryRoot.toUpperCase()}\\APPLICATION\\PENKRA.EXE`,
          CommandLine: null,
        },
      ]),
    );

    expect(findWindowsProcessesInsideRoot(inventory, temporaryRoot, 999)).toEqual(inventory);
  });

  it("matches command-line references to the exact root", () => {
    const inventory = parseWindowsProcessInventory(
      JSON.stringify([
        {
          ProcessId: 61,
          ExecutablePath: "C:\\Program Files\\nodejs\\node.exe",
          CommandLine: `node child.js --state-root="${temporaryRoot}\\penkra-root"`,
        },
      ]),
    );

    expect(findWindowsProcessesInsideRoot(inventory, temporaryRoot, 999)).toEqual(inventory);
  });

  it("ignores unrelated and sibling-root processes", () => {
    const inventory = parseWindowsProcessInventory(
      JSON.stringify([
        {
          ProcessId: 71,
          ExecutablePath: "C:\\Program Files\\Penkra\\Penkra.exe",
          CommandLine: "Penkra.exe --background",
        },
        {
          ProcessId: 72,
          ExecutablePath: `${temporaryRoot}-other\\Penkra.exe`,
          CommandLine: `"${temporaryRoot}-other\\Penkra.exe"`,
        },
      ]),
    );

    expect(findWindowsProcessesInsideRoot(inventory, temporaryRoot, 999)).toEqual([]);
  });

  it("excludes the current process even when its command line references the root", () => {
    const inventory = parseWindowsProcessInventory(
      JSON.stringify([
        {
          ProcessId: 81,
          ExecutablePath: "C:\\Program Files\\nodejs\\node.exe",
          CommandLine: `node verify.js "${temporaryRoot}"`,
        },
      ]),
    );

    expect(findWindowsProcessesInsideRoot(inventory, temporaryRoot, 81)).toEqual([]);
  });

  it("parses and excludes the PID-zero system process with null fields", () => {
    const inventory = parseWindowsProcessInventory(
      JSON.stringify([{ ProcessId: 0, ExecutablePath: null, CommandLine: null }]),
    );

    expect(inventory).toEqual([{ processId: 0, executablePath: null, commandLine: null }]);
    expect(findWindowsProcessesInsideRoot(inventory, temporaryRoot, 999)).toEqual([]);
  });

  it("defensively excludes PID zero even when its command line references the root", () => {
    const inventory = parseWindowsProcessInventory(
      JSON.stringify([
        {
          ProcessId: 0,
          ExecutablePath: null,
          CommandLine: `System Idle Process "${temporaryRoot}"`,
        },
      ]),
    );

    expect(findWindowsProcessesInsideRoot(inventory, temporaryRoot, 999)).toEqual([]);
  });

  it("rejects negative and noninteger process IDs", () => {
    for (const ProcessId of [-1, 1.5]) {
      expect(() =>
        parseWindowsProcessInventory(
          JSON.stringify([{ ProcessId, ExecutablePath: null, CommandLine: null }]),
        ),
      ).toThrow("Windows process inventory entry 0 has an invalid ProcessId");
    }
  });

  it("fails clearly for empty or malformed PowerShell JSON", () => {
    expect(() => parseWindowsProcessInventory("  \n")).toThrow(
      "Windows process inventory returned empty PowerShell JSON",
    );
    expect(() => parseWindowsProcessInventory("not-json")).toThrow(
      "Windows process inventory returned malformed PowerShell JSON",
    );
    expect(() => parseWindowsProcessInventory("{}")).toThrow(
      "Windows process inventory PowerShell JSON must be an array",
    );
  });

  it("reports every survivor with actionable process diagnostics", () => {
    expect(
      formatWindowsProcessSurvivorError(temporaryRoot, [
        {
          processId: 91,
          executablePath: `${temporaryRoot}\\application\\Penkra.exe`,
          commandLine: `"${temporaryRoot}\\application\\Penkra.exe" --type=utility`,
        },
        {
          processId: 92,
          executablePath: null,
          commandLine: `node child.js --root="${temporaryRoot}"`,
        },
      ]),
    ).toBe(
      [
        `Packaged desktop smoke left Windows processes referencing its temporary root ${JSON.stringify(temporaryRoot)}:`,
        `- pid=91 executablePath=${JSON.stringify(`${temporaryRoot}\\application\\Penkra.exe`)} commandLine=${JSON.stringify(`"${temporaryRoot}\\application\\Penkra.exe" --type=utility`)}`,
        `- pid=92 executablePath=null commandLine=${JSON.stringify(`node child.js --root="${temporaryRoot}"`)}`,
      ].join("\n"),
    );
  });
});
