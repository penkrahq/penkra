// FILE: simulatorDeviceStore.ts
// Purpose: Atomically persists App-and-Space-owned simulator device definitions.
// Layer: Trusted desktop simulator host

import * as FS from "node:fs";
import * as Path from "node:path";

import type { SimulatorStoredDevice } from "./simulatorManager";
import { resolveDesktopPlatformAdapter } from "./desktopPlatform";

export const SIMULATOR_DEVICE_STATE_FILE_NAME = "devices-v1.json";
export const SIMULATOR_DEVICE_STATE_MAX_BYTES = 4 * 1024 * 1024;

export interface SimulatorDeviceState {
  version: 1;
  devices: ReadonlyArray<SimulatorStoredDevice>;
}

export type SimulatorDeviceStateReadResult =
  | { status: "missing"; state: SimulatorDeviceState }
  | { status: "ready"; state: SimulatorDeviceState }
  | { status: "corrupt"; error: Error };

export function resolveSimulatorDeviceStatePath(userDataPath: string): string {
  return Path.join(userDataPath, "simulator", SIMULATOR_DEVICE_STATE_FILE_NAME);
}

export function parseSimulatorDeviceState(value: unknown): SimulatorDeviceState {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.devices)) {
    throw new Error("Simulator device state must be a version 1 object.");
  }
  const ids = new Set<string>();
  const devices = value.devices.map((candidate, index) => {
    if (!isRecord(candidate)) throw new Error(`Simulator device ${index} must be an object.`);
    const device: SimulatorStoredDevice = {
      id: boundedString(candidate.id, `devices[${index}].id`, 256),
      platform: enumValue(candidate.platform, `devices[${index}].platform`, ["android", "ios"]),
      runtimeId: boundedString(candidate.runtimeId, `devices[${index}].runtimeId`, 512),
      deviceTypeId: boundedString(candidate.deviceTypeId, `devices[${index}].deviceTypeId`, 512),
      formFactor: enumValue(candidate.formFactor, `devices[${index}].formFactor`, [
        "phone",
        "tablet",
      ]),
      name: boundedString(candidate.name, `devices[${index}].name`, 256),
      appId: boundedString(candidate.appId, `devices[${index}].appId`, 256),
      spaceId: boundedString(candidate.spaceId, `devices[${index}].spaceId`, 256),
    };
    if (ids.has(device.id)) throw new Error(`Duplicate simulator device ID: ${device.id}.`);
    ids.add(device.id);
    return device;
  });
  return { version: 1, devices };
}

export async function readSimulatorDeviceState(
  filePath: string,
): Promise<SimulatorDeviceStateReadResult> {
  let handle: FS.promises.FileHandle | null = null;
  try {
    handle = await FS.promises.open(filePath, "r");
    const stats = await handle.stat();
    if (!stats.isFile()) {
      return { status: "corrupt", error: new Error("Simulator device state is not a file.") };
    }
    if (stats.size > SIMULATOR_DEVICE_STATE_MAX_BYTES) {
      return {
        status: "corrupt",
        error: new Error(
          `Simulator device state exceeds ${SIMULATOR_DEVICE_STATE_MAX_BYTES} bytes.`,
        ),
      };
    }
    return {
      status: "ready",
      state: parseSimulatorDeviceState(JSON.parse(await handle.readFile("utf8"))),
    };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { status: "missing", state: { version: 1, devices: [] } };
    }
    return { status: "corrupt", error: toError(error) };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function writeSimulatorDeviceState(
  filePath: string,
  state: SimulatorDeviceState,
): Promise<void> {
  const validated = parseSimulatorDeviceState(state);
  const contents = `${JSON.stringify(validated, null, 2)}\n`;
  if (Buffer.byteLength(contents, "utf8") > SIMULATOR_DEVICE_STATE_MAX_BYTES) {
    throw new Error(`Simulator device state exceeds ${SIMULATOR_DEVICE_STATE_MAX_BYTES} bytes.`);
  }
  const parentPath = Path.dirname(filePath);
  const temporaryPath = Path.join(
    parentPath,
    `.${Path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  let handle: FS.promises.FileHandle | null = null;
  try {
    await FS.promises.mkdir(parentPath, { recursive: true, mode: 0o700 });
    handle = await FS.promises.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await FS.promises.rename(temporaryPath, filePath);
    await syncDirectory(parentPath);
  } finally {
    await handle?.close().catch(() => undefined);
    await FS.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export class SimulatorDeviceStore {
  readonly filePath: string;
  #state: SimulatorDeviceState;
  #queue: Promise<void> = Promise.resolve();

  private constructor(filePath: string, state: SimulatorDeviceState) {
    this.filePath = filePath;
    this.#state = state;
  }

  static async openSafe(filePath: string): Promise<{
    store: SimulatorDeviceStore;
    recovery: null | { quarantinedPath: string; error: Error };
  }> {
    const result = await readSimulatorDeviceState(filePath);
    if (result.status !== "corrupt") {
      return { store: new SimulatorDeviceStore(filePath, result.state), recovery: null };
    }
    const extension = Path.extname(filePath);
    const quarantinedPath = Path.join(
      Path.dirname(filePath),
      `${Path.basename(filePath, extension)}.corrupt-${Date.now()}-${process.pid}${extension}`,
    );
    await FS.promises.rename(filePath, quarantinedPath);
    return {
      store: new SimulatorDeviceStore(filePath, { version: 1, devices: [] }),
      recovery: { quarantinedPath, error: result.error },
    };
  }

  snapshot(): SimulatorDeviceState {
    return this.#state;
  }

  replace(devices: ReadonlyArray<SimulatorStoredDevice>): Promise<SimulatorDeviceState> {
    const operation = this.#queue.then(async () => {
      const next = parseSimulatorDeviceState({ version: 1, devices });
      await writeSimulatorDeviceState(this.filePath, next);
      this.#state = next;
    });
    this.#queue = operation.catch(() => undefined);
    return operation.then(() => this.#state);
  }
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`${label} must be a non-empty string of at most ${maximum} characters.`);
  }
  return value;
}

function enumValue<const T extends string>(
  value: unknown,
  label: string,
  allowed: ReadonlyArray<T>,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

async function syncDirectory(directoryPath: string): Promise<void> {
  let handle: FS.promises.FileHandle | null = null;
  try {
    handle = await FS.promises.open(directoryPath, "r");
    await handle.sync();
  } catch (error) {
    if (resolveDesktopPlatformAdapter().processLifecycle.syncDirectories) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
