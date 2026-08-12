import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { openDesktopSimulatorHostRuntime } from "./simulatorHostRuntime";
import { resolveSimulatorDeviceStatePath } from "./simulatorDeviceStore";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => FS.promises.rm(path, { recursive: true })),
  );
});

async function temporaryUserDataPath(): Promise<string> {
  const path = await FS.promises.mkdtemp(Path.join(OS.tmpdir(), "penkra-simulator-runtime-"));
  temporaryDirectories.push(path);
  return path;
}

describe("openDesktopSimulatorHostRuntime", () => {
  it("restores durable definitions without restoring transient lifecycle state", async () => {
    const userDataPath = await temporaryUserDataPath();
    const filePath = resolveSimulatorDeviceStatePath(userDataPath);
    await FS.promises.mkdir(Path.dirname(filePath), { recursive: true });
    await FS.promises.writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        devices: [
          {
            id: "device-1",
            platform: "android",
            runtimeId: "android-36",
            deviceTypeId: "pixel-8",
            formFactor: "phone",
            name: "Pixel 8",
            appId: "com.penkra.simulator",
            spaceId: "space-a",
            state: "ready",
            processId: 1234,
          },
        ],
      }),
      "utf8",
    );

    const runtime = await openDesktopSimulatorHostRuntime({ userDataPath, adapters: [] });

    expect(runtime.recovery).toBeNull();
    expect(
      runtime.manager.listDevices({ appId: "com.penkra.simulator", spaceId: "space-a" }),
    ).toEqual([expect.objectContaining({ id: "device-1", state: "stopped", lastError: null })]);
  });

  it("reports and quarantines corrupt state", async () => {
    const userDataPath = await temporaryUserDataPath();
    const filePath = resolveSimulatorDeviceStatePath(userDataPath);
    await FS.promises.mkdir(Path.dirname(filePath), { recursive: true });
    await FS.promises.writeFile(filePath, "bad-json", "utf8");

    const runtime = await openDesktopSimulatorHostRuntime({ userDataPath, adapters: [] });

    expect(runtime.recovery?.error).toBeInstanceOf(Error);
    expect(runtime.store.snapshot().devices).toEqual([]);
  });

  it("disposes native adapter resources exactly once", async () => {
    const userDataPath = await temporaryUserDataPath();
    const disposeResources = vi.fn(async () => undefined);
    const runtime = await openDesktopSimulatorHostRuntime({
      userDataPath,
      adapters: [],
      disposeResources,
    });

    await runtime.dispose();
    await runtime.dispose();

    expect(disposeResources).toHaveBeenCalledOnce();
  });
});
