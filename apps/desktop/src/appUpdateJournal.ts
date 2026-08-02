// FILE: appUpdateJournal.ts
// Purpose: Makes registry App updates recoverable across process and machine interruption.
// Layer: Trusted desktop App persistence

import * as FS from "node:fs";
import * as Path from "node:path";

import { parseAppInstallationState, type AppInstallationState } from "./appInstallationState";
import type { AppInstallationStore } from "./appInstallationStore";

export const APP_UPDATE_JOURNAL_FILE_NAME = "update-journal-v1.json";
const APP_UPDATE_JOURNAL_MAX_BYTES = 5 * 1024 * 1024;

type AppUpdateJournalRecord = {
  schemaVersion: 1;
  appId: string;
  targetVersion: string;
  createdAt: string;
  previousState: AppInstallationState;
};

export type AppUpdateRecovery =
  | { status: "restored"; appId: string; targetVersion: string }
  | { status: "corrupt"; quarantinedPath: string; error: Error };

export function resolveAppUpdateJournalPath(userDataPath: string): string {
  return Path.join(userDataPath, "apps", APP_UPDATE_JOURNAL_FILE_NAME);
}

export class AppUpdateJournal {
  readonly filePath: string;

  constructor(filePath: string) {
    if (!Path.isAbsolute(filePath)) throw new TypeError("App update journal path must be absolute.");
    this.filePath = filePath;
  }

  async prepare(input: {
    appId: string;
    targetVersion: string;
    previousState: AppInstallationState;
  }): Promise<void> {
    const record: AppUpdateJournalRecord = {
      schemaVersion: 1,
      appId: requireText(input.appId, "appId"),
      targetVersion: requireText(input.targetVersion, "targetVersion"),
      createdAt: new Date().toISOString(),
      previousState: parseAppInstallationState(input.previousState),
    };
    await writeJournal(this.filePath, record);
  }

  async clear(): Promise<void> {
    try {
      await FS.promises.unlink(this.filePath);
      await syncDirectory(Path.dirname(this.filePath));
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
  }

  async recoverSafe(store: Pick<AppInstallationStore, "mutate">): Promise<AppUpdateRecovery | null> {
    const result = await readJournal(this.filePath);
    if (result.status === "missing") return null;
    if (result.status === "corrupt") {
      const quarantinedPath = Path.join(
        Path.dirname(this.filePath),
        `${Path.basename(this.filePath, ".json")}.corrupt-${Date.now()}-${process.pid}.json`,
      );
      await FS.promises.rename(this.filePath, quarantinedPath);
      return { status: "corrupt", quarantinedPath, error: result.error };
    }
    await store.mutate(() => result.record.previousState);
    await this.clear();
    return {
      status: "restored",
      appId: result.record.appId,
      targetVersion: result.record.targetVersion,
    };
  }
}

type ReadJournalResult =
  | { status: "missing" }
  | { status: "ready"; record: AppUpdateJournalRecord }
  | { status: "corrupt"; error: Error };

async function readJournal(filePath: string): Promise<ReadJournalResult> {
  let handle: FS.promises.FileHandle | null = null;
  try {
    handle = await FS.promises.open(filePath, "r");
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > APP_UPDATE_JOURNAL_MAX_BYTES) {
      throw new Error("App update journal is not a valid bounded file.");
    }
    const value = JSON.parse(await handle.readFile("utf8")) as unknown;
    return { status: "ready", record: parseJournal(value) };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return { status: "missing" };
    return { status: "corrupt", error: toError(error) };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseJournal(value: unknown): AppUpdateJournalRecord {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new Error("App update journal schema is invalid.");
  const createdAt = requireText(value.createdAt, "createdAt");
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error("App update journal time is invalid.");
  return {
    schemaVersion: 1,
    appId: requireText(value.appId, "appId"),
    targetVersion: requireText(value.targetVersion, "targetVersion"),
    createdAt,
    previousState: parseAppInstallationState(value.previousState),
  };
}

async function writeJournal(filePath: string, record: AppUpdateJournalRecord): Promise<void> {
  const contents = `${JSON.stringify(record, null, 2)}\n`;
  if (Buffer.byteLength(contents, "utf8") > APP_UPDATE_JOURNAL_MAX_BYTES) {
    throw new Error("App update journal exceeds its size limit.");
  }
  const parentPath = Path.dirname(filePath);
  const temporaryPath = Path.join(parentPath, `.${APP_UPDATE_JOURNAL_FILE_NAME}.${process.pid}.${Date.now()}.tmp`);
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

async function syncDirectory(directoryPath: string): Promise<void> {
  let handle: FS.promises.FileHandle | null = null;
  try {
    handle = await FS.promises.open(directoryPath, "r");
    await handle.sync();
  } catch (error) {
    if (process.platform !== "win32") throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`App update journal ${label} is invalid.`);
  return value;
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
