import { describe, expect, it, vi } from "vitest";

import {
  closeAppleSimulatorAutomationSession,
  createDesktopSimulatorAdapterBundle,
} from "./simulatorAdapterBundle";

describe("desktop simulator adapter bundle", () => {
  it("composes Android on every supported host and Apple only on macOS", async () => {
    const mac = await createDesktopSimulatorAdapterBundle({
      platform: "darwin",
      userDataPath: "/tmp/penkra-test",
      environment: {},
      pathExists: async () => false,
    });
    const linux = await createDesktopSimulatorAdapterBundle({
      platform: "linux",
      userDataPath: "/tmp/penkra-test",
      environment: {},
      pathExists: async () => false,
    });

    expect(mac.adapters.map((adapter) => adapter.platform)).toEqual(["android", "ios"]);
    expect(linux.adapters.map((adapter) => adapter.platform)).toEqual(["android"]);
    expect(mac.diagnostics).toMatchObject({
      platform: "darwin",
      androidSdkRoot: null,
      appiumExecutable: null,
      webDriverAgentProject: null,
    });
    await mac.dispose();
    await mac.dispose();
    await linux.dispose();
  });

  it("reports missing prerequisites without trying to launch placeholder tools", async () => {
    const bundle = await createDesktopSimulatorAdapterBundle({
      platform: "darwin",
      userDataPath: "/tmp/penkra-test",
      environment: {},
      pathExists: async () => false,
    });

    const environment = await new (
      await import("./simulatorManager")
    ).DesktopSimulatorManager(bundle.adapters).getEnvironment();
    expect(environment.platforms).toEqual([
      expect.objectContaining({ platform: "android", status: "setup-required" }),
      expect.objectContaining({ platform: "ios", status: "setup-required" }),
    ]);
    await bundle.dispose();
  });
});

describe("Apple simulator session cleanup", () => {
  it("treats a failed Appium session DELETE as non-fatal after Appium stops", async () => {
    const deleteFailure = new Error("Appium DELETE /session failed");
    const dispose = vi.fn(async () => Promise.reject(deleteFailure));
    const stop = vi.fn(async () => undefined);

    await expect(
      closeAppleSimulatorAutomationSession({
        automation: { dispose },
        server: { stop },
      }),
    ).resolves.toBeUndefined();
    expect(dispose).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("preserves cleanup rejection when the owning Appium process groups do not stop", async () => {
    const deleteFailure = new Error("Appium DELETE /session failed");
    const stopFailure = Object.assign(new Error("Appium process group remains live"), {
      code: "APPIUM_STOP_FAILED",
    });

    await expect(
      closeAppleSimulatorAutomationSession({
        automation: { dispose: async () => Promise.reject(deleteFailure) },
        server: { stop: async () => Promise.reject(stopFailure) },
      }),
    ).rejects.toMatchObject({
      message: "Apple session cleanup failed.",
      errors: [deleteFailure, stopFailure],
    });
  });
});
