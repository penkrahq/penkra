import Path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  AppleSimulatorToolchain,
  MANAGED_APPIUM_VERSION,
  MANAGED_XCUITEST_VERSION,
  managedToolchainInstallArguments,
} from "./appleSimulatorToolchain";

describe("Apple Simulator automation toolchain", () => {
  it("installs one compatible Appium and XCUITest pair into Penkra-owned state", async () => {
    const root = "/tmp/penkra/simulator/apple/appium";
    const existing = new Set(["/usr/local/bin/npm"]);
    const installer = {
      install: vi.fn(async () => {
        existing.add(Path.join(root, "node_modules", ".bin", "appium"));
        existing.add(
          Path.join(
            root,
            "node_modules",
            "appium-xcuitest-driver",
            "node_modules",
            "appium-webdriveragent",
            "WebDriverAgent.xcodeproj",
          ),
        );
      }),
    };
    const signal = new AbortController().signal;
    const toolchain = new AppleSimulatorToolchain({
      userDataPath: "/tmp/penkra",
      environment: { PATH: "/usr/local/bin" },
      pathExists: async (path) => existing.has(path),
      installer,
    });

    const installed = await toolchain.install(signal);

    expect(installer.install).toHaveBeenCalledWith({
      executable: "/usr/local/bin/npm",
      args: managedToolchainInstallArguments(root),
      signal,
    });
    expect(installed).toMatchObject({ appiumHome: root });
    expect(managedToolchainInstallArguments(root)).toContain(`appium@${MANAGED_APPIUM_VERSION}`);
    expect(managedToolchainInstallArguments(root)).toContain(
      `appium-xcuitest-driver@${MANAGED_XCUITEST_VERSION}`,
    );
  });

  it("reuses an ambient Appium home only when both executable and driver are present", async () => {
    const home = "/Users/test/.appium";
    const paths = new Set([
      "/opt/bin/appium",
      Path.join(
        home,
        "node_modules",
        "appium-xcuitest-driver",
        "node_modules",
        "appium-webdriveragent",
        "WebDriverAgent.xcodeproj",
      ),
    ]);
    const toolchain = new AppleSimulatorToolchain({
      userDataPath: "/tmp/penkra",
      environment: { HOME: "/Users/test", PATH: "/opt/bin" },
      pathExists: async (path) => paths.has(path),
      installer: { install: vi.fn() },
    });

    await expect(toolchain.resolve()).resolves.toMatchObject({
      appiumExecutable: "/opt/bin/appium",
      appiumHome: home,
    });
  });
});
