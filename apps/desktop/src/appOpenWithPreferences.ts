// FILE: appOpenWithPreferences.ts
// Purpose: Persists deterministic device-wide Open With choices for URLs, folders, and file types.
// Layer: Trusted desktop App routing state

import * as FS from "node:fs";
import * as Path from "node:path";

export type AppOpenIntent = "open-url" | "open-file" | "open-directory";
export interface AppOpenWithPreferences {
  "open-url"?: string;
  "open-directory"?: string;
  files: Readonly<Record<string, string>>;
}

const FILE_NAME = "open-with-v4.json";
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
    let state: AppOpenWithPreferences;
    try {
      state = parsePreferences(await readJson(filePath));
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      state = await migrateLegacyPreferences(Path.dirname(filePath));
      if (hasPreferences(state)) await writePreferences(filePath, state);
    }
    return new AppOpenWithPreferenceStore(filePath, state);
  }

  snapshot(): AppOpenWithPreferences {
    return this.#state;
  }

  forSpace(spaceId: string): AppOpenWithPreferences {
    requireText(spaceId, "spaceId");
    return this.#state;
  }

  get(spaceId: string, intent: AppOpenIntent, extension?: string): string | undefined {
    const current = this.forSpace(spaceId);
    if (intent === "open-file") {
      const normalized = normalizeExtension(extension);
      return normalized === null ? undefined : current.files[normalized];
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
      let next: AppOpenWithPreferences;
      if (intent === "open-file") {
        const normalized = normalizeExtension(extension);
        if (normalized === null)
          throw new Error("A file Open With preference requires an extension.");
        const files = { ...this.#state.files };
        if (appId === null) delete files[normalized];
        else files[normalized] = requireText(appId, "appId");
        next = { ...this.#state, files };
      } else {
        next = { ...this.#state, files: { ...this.#state.files } };
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

async function migrateLegacyPreferences(directory: string): Promise<AppOpenWithPreferences> {
  const v1 = await readOptionalJson(Path.join(directory, "open-with-v1.json"));
  const v2 = await readOptionalJson(Path.join(directory, "open-with-v2.json"));
  const v3 = await readOptionalJson(Path.join(directory, "open-with-v3.json"));
  const older =
    v2 !== null
      ? parseLegacyV2(v2)
      : v1 !== null
        ? parseLegacySpacePreferences(v1, false)
        : emptyPreferences();
  if (v3 === null) return older;
  const urls = parseLegacyV3(v3);
  return { ...older, ...urls, files: { ...older.files } };
}

function parseLegacyV2(value: unknown): AppOpenWithPreferences {
  if (!isRecord(value)) throw new Error("Open With v2 state must be an object.");
  if ("files" in value || "open-url" in value || "open-directory" in value) {
    // Early v2 files stored only URL and directory choices. File associations were added later,
    // so a missing `files` object is valid legacy state and migrates to an empty map.
    return parsePreferences({ ...value, files: value.files ?? {} });
  }
  return parseLegacySpacePreferences(value, true);
}

// Older per-Space files have no global recency marker. Keep the first persisted choice for each
// association deterministically, matching the v2 migration behavior that shipped previously.
function parseLegacySpacePreferences(
  value: unknown,
  includeFiles: boolean,
): AppOpenWithPreferences {
  if (!isRecord(value)) throw new Error("Legacy Open With state must be an object.");
  const result: { "open-url"?: string; "open-directory"?: string; files: Record<string, string> } =
    {
      files: {},
    };
  for (const [spaceId, candidate] of Object.entries(value)) {
    requireText(spaceId, "spaceId");
    if (!isRecord(candidate)) throw new Error("Open With Space state must be an object.");
    if (result["open-url"] === undefined && candidate["open-url"] !== undefined) {
      result["open-url"] = requireText(candidate["open-url"], "open-url");
    }
    if (result["open-directory"] === undefined && candidate["open-directory"] !== undefined) {
      result["open-directory"] = requireText(candidate["open-directory"], "open-directory");
    }
    if (!includeFiles || candidate.files === undefined) continue;
    if (!isRecord(candidate.files))
      throw new Error("Open With file preferences must be an object.");
    for (const [extension, appId] of Object.entries(candidate.files)) {
      const normalized = normalizeExtension(extension);
      if (normalized === null || normalized !== extension) {
        throw new Error(`Invalid Open With file extension ${extension}.`);
      }
      result.files[normalized] ??= requireText(appId, `files.${extension}`);
    }
  }
  return result;
}

function parseLegacyV3(value: unknown): Pick<AppOpenWithPreferences, "open-url"> {
  if (!isRecord(value)) throw new Error("Open With v3 state must be an object.");
  return value["open-url"] === undefined
    ? {}
    : { "open-url": requireText(value["open-url"], "open-url") };
}

function parsePreferences(value: unknown): AppOpenWithPreferences {
  if (!isRecord(value)) throw new Error("Open With state must be an object.");
  for (const key of Object.keys(value)) {
    if (key !== "open-url" && key !== "open-directory" && key !== "files") {
      throw new Error(`Unknown Open With preference ${key}.`);
    }
  }
  if (!isRecord(value.files)) throw new Error("Open With file preferences must be an object.");
  const files: Record<string, string> = {};
  for (const [extension, appId] of Object.entries(value.files)) {
    const normalized = normalizeExtension(extension);
    if (normalized === null || normalized !== extension) {
      throw new Error(`Invalid Open With file extension ${extension}.`);
    }
    files[extension] = requireText(appId, `files.${extension}`);
  }
  return {
    ...(value["open-url"] === undefined
      ? {}
      : { "open-url": requireText(value["open-url"], "open-url") }),
    ...(value["open-directory"] === undefined
      ? {}
      : { "open-directory": requireText(value["open-directory"], "open-directory") }),
    files,
  };
}

function normalizeExtension(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return /^\.[a-z0-9][a-z0-9.+_-]*$/.test(normalized) ? normalized : null;
}

function emptyPreferences(): AppOpenWithPreferences {
  return { files: {} };
}

function hasPreferences(value: AppOpenWithPreferences): boolean {
  return Boolean(value["open-url"] || value["open-directory"] || Object.keys(value.files).length);
}

async function readJson(filePath: string): Promise<unknown> {
  const bytes = await FS.promises.readFile(filePath);
  if (bytes.byteLength > MAX_BYTES) throw new Error("Open With state exceeds its size limit.");
  return JSON.parse(bytes.toString("utf8"));
}

async function readOptionalJson(filePath: string): Promise<unknown | null> {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
