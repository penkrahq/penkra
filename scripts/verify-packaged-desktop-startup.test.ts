import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createPackagedDesktopSmokeEnvironment,
  extractPackagedDesktopBackendPort,
  inspectPackagedDesktopStartupLog,
  parsePackagedDesktopStartupArgs,
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
          "bootstrap required Apps controller ready spaces=1 version=0.2.5",
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
          "bootstrap required Apps controller ready spaces=1 version=0.2.5",
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
