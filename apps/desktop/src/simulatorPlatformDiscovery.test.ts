import Path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  discoverAndroidSimulator,
  discoverAppleSimulator,
  resolveAndroidSdkRoot,
} from "./simulatorPlatformDiscovery";

describe("simulator host platform discovery", () => {
  it("never attempts Apple discovery outside macOS", async () => {
    const runner = vi.fn();
    const result = await discoverAppleSimulator("linux", runner);

    expect(runner).not.toHaveBeenCalled();
    expect(result.availability).toMatchObject({
      platform: "ios",
      supported: false,
      status: "unsupported",
    });
  });

  it("uses the official shell-free simctl inventory command on macOS", async () => {
    const runner = vi.fn(async () => ({
      stdout: JSON.stringify({
        runtimes: [
          {
            identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
            name: "iOS 26.0",
            version: "26.0",
            isAvailable: true,
          },
        ],
        devicetypes: [],
      }),
      stderr: "",
    }));

    const result = await discoverAppleSimulator("darwin", runner);

    expect(runner).toHaveBeenCalledWith("xcrun", [
      "simctl",
      "list",
      "-j",
      "runtimes",
      "devicetypes",
    ]);
    expect(result.availability.status).toBe("available");
  });

  it("reports setup-required when Xcode has no compatible iOS runtime", async () => {
    const result = await discoverAppleSimulator("darwin", async () => ({
      stdout: JSON.stringify({ runtimes: [], devicetypes: [] }),
      stderr: "",
    }));

    expect(result.availability).toMatchObject({
      platform: "ios",
      supported: true,
      status: "setup-required",
    });
  });

  it("discovers Android only after required official SDK tools exist", async () => {
    const runner = vi
      .fn()
      .mockResolvedValueOnce({
        stdout:
          "Installed packages:\nPath | Version\nsystem-images;android-36;google_apis;arm64-v8a | 1",
        stderr: "",
      })
      .mockResolvedValueOnce({
        stdout: '----\nid: 0 or "pixel_8"\n    Name: Pixel 8\n',
        stderr: "",
      });
    const result = await discoverAndroidSimulator({
      platform: "darwin",
      environment: { ANDROID_HOME: "/sdk" },
      runner,
      pathExists: async () => true,
    });

    expect(runner).toHaveBeenNthCalledWith(
      1,
      Path.join("/sdk", "cmdline-tools", "latest", "bin", "sdkmanager"),
      ["--list"],
    );
    expect(result.availability.status).toBe("available");
    expect(result.inventory.runtimes).toHaveLength(1);
  });

  it("returns setup-required without running incomplete Android installations", async () => {
    const runner = vi.fn();
    const result = await discoverAndroidSimulator({
      platform: "linux",
      environment: { HOME: "/home/test" },
      runner,
      pathExists: async (path) => !path.endsWith("/emulator/emulator"),
    });

    expect(runner).not.toHaveBeenCalled();
    expect(result.availability).toMatchObject({ supported: true, status: "setup-required" });
  });

  it("honors explicit Android SDK configuration before platform defaults", () => {
    expect(
      resolveAndroidSdkRoot("win32", {
        ANDROID_SDK_ROOT: "C:\\custom-sdk",
        LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
      }),
    ).toContain("custom-sdk");
    expect(resolveAndroidSdkRoot("darwin", { HOME: "/Users/test" })).toBe(
      "/Users/test/Library/Android/sdk",
    );
  });
});
