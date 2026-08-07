// FILE: appOpenWithPreferences.ts
// Purpose: Persists deterministic device-wide Open With choices for URLs, folders, and file types.
// Layer: Trusted desktop App routing state

import * as FS from "node:fs";
import * as Path from "node:path";

export type AppOpenIntent = "open-url" | "open-file" | "open-directory";
export interface AppOpenWithSpacePreferences {
  "open-url"?: string;
  "open-directory"?: string;
  files: Readonly<Record<string, string>>;
}
export type AppOpenWithPreferences = AppOpenWithSpacePreferences;

const FILE_NAME = "open-with-v2.json";
const MAX_BYTES = 1024 * 1024;

export function resolveAppOpenWithPreferencesPath(userDataPath: string): string {
  return Path.join(userDataPath, "apps", FILE_NAME);
}

export class AppOpenWithPreferenceStore {
  readonly #filePath: string;
  #state: AppOpenWithPreferences;
  #queue: Promise<void> = Promise.resolve();

  private constructor(filePath: string, state: AppOpenWithPreferences) {
    this.#filePath = filePath;
    this.#state = state;
  }

  static async open(filePath: string): Promise<AppOpenWithPreferenceStore> {
    if (!Path.isAbsolute(filePath)) throw new TypeError("Open With state path must be absolute.");
    let state: AppOpenWithPreferences = { files: {} };
    try {
      const bytes = await FS.promises.readFile(filePath);
      if (bytes.byteLength > MAX_BYTES) throw new Error("Open With state exceeds its size limit.");
      state = parseStoredPreferences(JSON.parse(bytes.toString("utf8")));
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      state = await migrateV1(filePath);
      if (hasPreferences(state)) await writePreferences(filePath, state);
    }
    return new AppOpenWithPreferenceStore(filePath, state);
  }

  snapshot(): AppOpenWithPreferences {
    return this.#state;
  }

  forSpace(spaceId: string): AppOpenWithSpacePreferences {
    requireText(spaceId, "spaceId");
    return this.#state;
  }

  get(spaceId: string, intent: AppOpenIntent, extension?: string): string | undefined {
    const current = this.forSpace(spaceId);
    if (intent === "open-file") {
      const normalized = normalizeExtension(extension);
      return normalized ? current.files[normalized] : undefined;
    }
    return current[intent];
  }

  set(
    spaceId: string,
    intent: AppOpenIntent,
    appId: string | null,
    extension?: string,
  ): Promise<AppOpenWithPreferences> {
    requireText(spaceId, "spaceId");
    const operation = this.#queue.then(async () => {
      const current = this.#state;
      let next: AppOpenWithPreferences;
      if (intent === "open-file") {
        const normalized = normalizeExtension(extension);
        if (!normalized) throw new Error("A file Open With preference requires an extension.");
        const files = { ...current.files };
        if (appId === null) delete files[normalized];
        else files[normalized] = requireText(appId, "appId");
        next = { ...current, files };
      } else {
        next = { ...current, files: { ...current.files } };
        if (appId === null) delete next[intent];
        else next[intent] = requireText(appId, "appId");
      }
      await writePreferences(this.#filePath, next);
      this.#state = next;
    });
    this.#queue = operation.catch(() => undefined);
    return operation.then(() => this.#state);
  }
}

async function migrateV1(filePath: string): Promise<AppOpenWithPreferences> {
  const previousPath = Path.join(Path.dirname(filePath), "open-with-v1.json");
  let value: unknown;
  try {
    const bytes = await FS.promises.readFile(previousPath);
    if (bytes.byteLength > MAX_BYTES) throw new Error("Open With v1 state exceeds its size limit.");
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return { files: {} };
    throw error;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Open With v1 state must be an object.");
  }
  return migrateSpacePreferences(value, false);
}

function normalizeExtension(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return /^\.[a-z0-9][a-z0-9.+_-]*$/.test(normalized) ? normalized : null;
}

function parseStoredPreferences(value: unknown): AppOpenWithPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Open With state must be an object.");
  }
  const record = value as Record<string, unknown>;
  if ("files" in record || "open-url" in record || "open-directory" in record) {
    return parsePreferences(value);
  }
  return migrateSpacePreferences(value, true);
}

// Existing per-Space files have no globally meaningful recency marker. Keep the first persisted
// choice for each intent/extension deterministically; future writes use the global shape.
function migrateSpacePreferences(value: object, includeFiles: boolean): AppOpenWithPreferences {
  const files: Record<string, string> = {};
  const result: {
    "open-url"?: string;
    "open-directory"?: string;
    files: Record<string, string>;
  } = { files };
  for (const [spaceId, raw] of Object.entries(value)) {
    requireText(spaceId, "spaceId");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Open With Space state must be an object.");
    }
    const record = raw as Record<string, unknown>;
    if (result["open-url"] === undefined && record["open-url"] !== undefined) {
      result["open-url"] = requireText(record["open-url"], "open-url");
    }
    if (result["open-directory"] === undefined && record["open-directory"] !== undefined) {
      result["open-directory"] = requireText(record["open-directory"], "open-directory");
    }
    if (!includeFiles) continue;
    const rawFiles = record.files;
    if (!rawFiles || typeof rawFiles !== "object" || Array.isArray(rawFiles)) {
      throw new Error("Open With file preferences must be an object.");
    }
    for (const [extension, appId] of Object.entries(rawFiles)) {
      const normalized = normalizeExtension(extension);
      if (!normalized || normalized !== extension) {
        throw new Error(`Invalid Open With file extension ${extension}.`);
      }
      files[normalized] ??= requireText(appId, `files.${extension}`);
    }
  }
  return result;
}

function parsePreferences(value: unknown): AppOpenWithPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Open With state must be an object.");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "open-url" && key !== "open-directory" && key !== "files") {
      throw new Error(`Unknown Open With preference ${key}.`);
    }
  }
  const files = record.files;
  if (!files || typeof files !== "object" || Array.isArray(files)) {
    throw new Error("Open With file preferences must be an object.");
  }
  const normalizedFiles: Record<string, string> = {};
  for (const [extension, appId] of Object.entries(files)) {
    const normalized = normalizeExtension(extension);
    if (!normalized || normalized !== extension) {
      throw new Error(`Invalid Open With file extension ${extension}.`);
    }
    normalizedFiles[normalized] = requireText(appId, `files.${extension}`);
  }
  return {
    ...(record["open-url"] === undefined
      ? {}
      : { "open-url": requireText(record["open-url"], "open-url") }),
    ...(record["open-directory"] === undefined
      ? {}
      : { "open-directory": requireText(record["open-directory"], "open-directory") }),
    files: normalizedFiles,
  };
}

function hasPreferences(value: AppOpenWithPreferences): boolean {
  return Boolean(value["open-url"] || value["open-directory"] || Object.keys(value.files).length);
}

async function writePreferences(filePath: string, value: AppOpenWithPreferences): Promise<void> {
  const contents = `${JSON.stringify(parsePreferences(value), null, 2)}\n`;
  if (Buffer.byteLength(contents) > MAX_BYTES) throw new Error("Open With state is too large.");
  const directory = Path.dirname(filePath);
  const temporary = Path.join(directory, `.${FILE_NAME}.${process.pid}.${Date.now()}.tmp`);
  await FS.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await FS.promises.writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await FS.promises.rename(temporary, filePath);
  } finally {
    await FS.promises.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be non-empty.`);
  return value;
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
