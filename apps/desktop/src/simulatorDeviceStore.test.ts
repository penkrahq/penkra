import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseSimulatorDeviceState,
  readSimulatorDeviceState,
  resolveSimulatorDeviceStatePath,
  SimulatorDeviceStore,
} from "./simulatorDeviceStore";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => FS.promises.rm(path, { recursive: true })),
  );
});

function device(id = "device-1") {
  return {
    id,
    platform: "android" as const,
    runtimeId: "android-36",
    deviceTypeId: "pixel-8",
    formFactor: "phone" as const,
    name: "Pixel 8",
    appId: "com.penkra.simulator",
    spaceId: "space-a",
  };
}

async function temporaryStatePath(): Promise<string> {
  const directory = await FS.promises.mkdtemp(Path.join(OS.tmpdir(), "penkra-simulator-store-"));
  temporaryDirectories.push(directory);
  return resolveSimulatorDeviceStatePath(directory);
}

describe("SimulatorDeviceStore", () => {
  it("starts empty and atomically persists device definitions", async () => {
    const filePath = await temporaryStatePath();
    const { store, recovery } = await SimulatorDeviceStore.openSafe(filePath);

    expect(recovery).toBeNull();
    expect(store.snapshot()).toEqual({ version: 1, devices: [] });

    await store.replace([device()]);

    await expect(readSimulatorDeviceState(filePath)).resolves.toEqual({
      status: "ready",
      state: { version: 1, devices: [device()] },
    });
  });

  it("strips transient lifecycle fields and rejects duplicate IDs", () => {
    expect(() =>
      parseSimulatorDeviceState({
        version: 1,
        devices: [{ ...device(), state: "ready", processId: 1234 }],
      }),
    ).not.toThrow();
    expect(
      parseSimulatorDeviceState({
        version: 1,
        devices: [{ ...device(), state: "ready", processId: 1234 }],
      }).devices[0],
    ).not.toHaveProperty("state");
    expect(() => parseSimulatorDeviceState({ version: 1, devices: [device(), device()] })).toThrow(
      "Duplicate simulator device ID",
    );
  });

  it("quarantines corrupt state instead of silently overwriting it", async () => {
    const filePath = await temporaryStatePath();
    await FS.promises.mkdir(Path.dirname(filePath), { recursive: true });
    await FS.promises.writeFile(filePath, "not-json", "utf8");

    const { store, recovery } = await SimulatorDeviceStore.openSafe(filePath);

    expect(store.snapshot().devices).toEqual([]);
    expect(recovery?.error).toBeInstanceOf(Error);
    await expect(FS.promises.readFile(recovery!.quarantinedPath, "utf8")).resolves.toBe("not-json");
    await expect(FS.promises.access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes concurrent replacements in call order", async () => {
    const filePath = await temporaryStatePath();
    const { store } = await SimulatorDeviceStore.openSafe(filePath);

    await Promise.all([store.replace([device("first")]), store.replace([device("last")])]);

    expect(store.snapshot().devices.map(({ id }) => id)).toEqual(["last"]);
  });
});
