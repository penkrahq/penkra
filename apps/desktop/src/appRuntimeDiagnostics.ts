// FILE: appRuntimeDiagnostics.ts
// Purpose: Persists bounded, App-scoped runtime evidence for trusted diagnostics UI.
// Layer: Trusted desktop App runtime

import { randomUUID } from "node:crypto";
import * as FS from "node:fs/promises";
import * as Path from "node:path";

export const APP_RUNTIME_DIAGNOSTICS_MAX_BYTES = 2 * 1024 * 1024;
export const APP_RUNTIME_DIAGNOSTICS_MAX_ENTRIES = 2_000;

export type AppRuntimeDiagnosticKind =
  | "app-update-failed"
  | "operation-completed"
  | "operation-failed"
  | "permission-used"
  | "runtime-disabled"
  | "tab-crashed"
  | "tab-opened"
  | "tab-ready"
  | "tab-responsive"
  | "tab-unresponsive";

export interface AppRuntimeDiagnosticEntry {
  id: string;
  timestamp: string;
  kind: AppRuntimeDiagnosticKind;
  appId: string;
  spaceId: string;
  tabId?: string;
  operation?: string;
  invocationId?: string;
  callerApp?: string;
  durationMs?: number;
  memoryBytes?: number;
  message?: string;
}

export type AppRuntimeDiagnosticInput = Omit<AppRuntimeDiagnosticEntry, "id" | "timestamp">;

/**
 * A deliberately small JSONL journal. Writes are serialized, every record is
 * independently parseable, and compaction keeps the newest complete records.
 */
export class AppRuntimeDiagnostics {
  readonly #path: string;
  #writes = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  record(input: AppRuntimeDiagnosticInput): Promise<AppRuntimeDiagnosticEntry> {
    const entry = validateEntry({
      ...input,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
    });
    const operation = this.#writes.then(async () => {
      await FS.mkdir(Path.dirname(this.#path), { recursive: true });
      await this.#compactIfRequired(Buffer.byteLength(JSON.stringify(entry)) + 1);
      await FS.appendFile(this.#path, `${JSON.stringify(entry)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      return entry;
    });
    this.#writes = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async list(
    input: { appId?: string; spaceId?: string; limit?: number } = {},
  ): Promise<ReadonlyArray<AppRuntimeDiagnosticEntry>> {
    await this.#writes;
    const entries = await this.#read();
    const filtered = entries.filter(
      (entry) =>
        (input.appId === undefined || entry.appId === input.appId) &&
        (input.spaceId === undefined || entry.spaceId === input.spaceId),
    );
    const limit = Math.min(Math.max(input.limit ?? 200, 1), APP_RUNTIME_DIAGNOSTICS_MAX_ENTRIES);
    return filtered.slice(-limit).reverse();
  }

  async #compactIfRequired(incomingBytes: number): Promise<void> {
    const stat = await FS.stat(this.#path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat || stat.size + incomingBytes <= APP_RUNTIME_DIAGNOSTICS_MAX_BYTES) return;
    const entries = await this.#read();
    const retained: string[] = [];
    let bytes = incomingBytes;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const line = `${JSON.stringify(entries[index])}\n`;
      const lineBytes = Buffer.byteLength(line);
      if (bytes + lineBytes > Math.floor(APP_RUNTIME_DIAGNOSTICS_MAX_BYTES / 2)) break;
      retained.unshift(line);
      bytes += lineBytes;
    }
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    await FS.writeFile(temporary, retained.join(""), { encoding: "utf8", mode: 0o600 });
    await FS.rename(temporary, this.#path);
  }

  async #read(): Promise<AppRuntimeDiagnosticEntry[]> {
    const text = await FS.readFile(this.#path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    if (!text) return [];
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    return lines.map((line, index) => {
      try {
        return validateEntry(JSON.parse(line));
      } catch (error) {
        throw new Error(
          `App diagnostics record ${index + 1} is invalid: ${toError(error).message}`,
        );
      }
    });
  }
}

export function resolveAppRuntimeDiagnosticsPath(userDataPath: string): string {
  return Path.join(userDataPath, "apps", "diagnostics.jsonl");
}

function validateEntry(value: unknown): AppRuntimeDiagnosticEntry {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("record must be an object");
  const candidate = value as Record<string, unknown>;
  for (const field of ["id", "timestamp", "kind", "appId", "spaceId"] as const) {
    if (typeof candidate[field] !== "string" || candidate[field].length === 0) {
      throw new Error(`${field} must be a non-empty string`);
    }
  }
  const kinds: ReadonlySet<string> = new Set([
    "app-update-failed",
    "operation-completed",
    "operation-failed",
    "permission-used",
    "runtime-disabled",
    "tab-crashed",
    "tab-opened",
    "tab-ready",
    "tab-responsive",
    "tab-unresponsive",
  ] satisfies AppRuntimeDiagnosticKind[]);
  if (!kinds.has(candidate.kind as string)) throw new Error("kind is not recognized");
  if (!Number.isFinite(Date.parse(candidate.timestamp as string)))
    throw new Error("timestamp must be ISO-compatible");
  for (const field of ["tabId", "operation", "invocationId", "callerApp", "message"] as const) {
    if (candidate[field] !== undefined && typeof candidate[field] !== "string")
      throw new Error(`${field} must be a string`);
  }
  for (const field of ["durationMs", "memoryBytes"] as const) {
    if (
      candidate[field] !== undefined &&
      (typeof candidate[field] !== "number" ||
        !Number.isFinite(candidate[field]) ||
        candidate[field] < 0)
    ) {
      throw new Error(`${field} must be a non-negative finite number`);
    }
  }
  return candidate as unknown as AppRuntimeDiagnosticEntry;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
