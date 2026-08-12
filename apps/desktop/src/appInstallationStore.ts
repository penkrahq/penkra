// FILE: appInstallationStore.ts
// Purpose: Atomically persists trusted profile App installation state without hiding corruption.
// Layer: Trusted desktop App runtime

import * as FS from "node:fs";
import * as Path from "node:path";

import { resolveDesktopPlatformAdapter } from "./desktopPlatform";

import {
  createEmptyAppInstallationState,
  parseAppInstallationState,
  type AppInstallationState,
} from "./appInstallationState";

export const APP_INSTALLATION_STATE_FILE_NAME = "installations-v1.json";
export const APP_INSTALLATION_STATE_MAX_BYTES = 4 * 1024 * 1024;

export type AppInstallationStateReadResult =
  | { status: "missing"; state: AppInstallationState }
  | { status: "ready"; state: AppInstallationState }
  | { status: "corrupt"; error: Error };

export function resolveAppInstallationStatePath(userDataPath: string): string {
  return Path.join(userDataPath, "apps", APP_INSTALLATION_STATE_FILE_NAME);
}

export async function readAppInstallationState(
  filePath: string,
): Promise<AppInstallationStateReadResult> {
  let handle: FS.promises.FileHandle | null = null;
  try {
    handle = await FS.promises.open(filePath, "r");
    const stats = await handle.stat();
    if (!stats.isFile()) {
      return { status: "corrupt", error: new Error("App installation state is not a file.") };
    }
    if (stats.size > APP_INSTALLATION_STATE_MAX_BYTES) {
      return {
        status: "corrupt",
        error: new Error(
          `App installation state exceeds ${APP_INSTALLATION_STATE_MAX_BYTES} bytes.`,
        ),
      };
    }
    const contents = await handle.readFile("utf8");
    return { status: "ready", state: parseAppInstallationState(JSON.parse(contents)) };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { status: "missing", state: createEmptyAppInstallationState() };
    }
    return { status: "corrupt", error: toError(error) };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function writeAppInstallationState(
  filePath: string,
  state: AppInstallationState,
): Promise<void> {
  const validated = parseAppInstallationState(state);
  const contents = `${JSON.stringify(validated, null, 2)}\n`;
  if (Buffer.byteLength(contents, "utf8") > APP_INSTALLATION_STATE_MAX_BYTES) {
    throw new Error(`App installation state exceeds ${APP_INSTALLATION_STATE_MAX_BYTES} bytes.`);
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

/**
 * Serializes state transitions and publishes the in-memory snapshot only after
 * its atomic write succeeds. A failed mutation leaves the prior snapshot live.
 */
export class AppInstallationStore {
  readonly filePath: string;
  #state: AppInstallationState;
  #queue: Promise<void> = Promise.resolve();

  private constructor(filePath: string, state: AppInstallationState) {
    this.filePath = filePath;
    this.#state = state;
  }

  static async open(filePath: string): Promise<AppInstallationStore> {
    const result = await readAppInstallationState(filePath);
    if (result.status === "corrupt") {
      throw new Error(`Unable to read App installation state: ${result.error.message}`, {
        cause: result.error,
      });
    }
    return new AppInstallationStore(filePath, result.state);
  }

  static async openSafe(filePath: string): Promise<{
    store: AppInstallationStore;
    recovery: null | { quarantinedPath: string; error: Error };
  }> {
    const result = await readAppInstallationState(filePath);
    if (result.status !== "corrupt") {
      return { store: new AppInstallationStore(filePath, result.state), recovery: null };
    }
    const quarantinedPath = Path.join(
      Path.dirname(filePath),
      `${Path.basename(filePath, Path.extname(filePath))}.corrupt-${Date.now()}-${process.pid}${Path.extname(filePath)}`,
    );
    await FS.promises.rename(filePath, quarantinedPath);
    return {
      store: new AppInstallationStore(filePath, createEmptyAppInstallationState()),
      recovery: { quarantinedPath, error: result.error },
    };
  }

  snapshot(): AppInstallationState {
    return this.#state;
  }

  mutate(
    transition: (state: AppInstallationState) => AppInstallationState,
  ): Promise<AppInstallationState> {
    const operation = this.#queue.then(async () => {
      const next = transition(this.#state);
      if (next === this.#state) return;
      await writeAppInstallationState(this.filePath, next);
      this.#state = next;
    });
    this.#queue = operation.catch(() => undefined);
    return operation.then(() => this.#state);
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  let handle: FS.promises.FileHandle | null = null;
  try {
    handle = await FS.promises.open(directoryPath, "r");
    await handle.sync();
  } catch (error) {
    // Windows and some filesystems do not permit fsync on directories. The file
    // itself was synced before rename, so directory sync is a durability bonus.
    if (resolveDesktopPlatformAdapter().processLifecycle.syncDirectories) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
