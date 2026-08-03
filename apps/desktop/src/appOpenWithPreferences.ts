// FILE: appOpenWithPreferences.ts
// Purpose: Persists deterministic per-Space Open With choices for App intents.
// Layer: Trusted desktop App routing state

import * as FS from "node:fs";
import * as Path from "node:path";

export type AppOpenIntent = "open-url" | "open-file" | "open-directory";
export type AppOpenWithPreferences = Readonly<
  Record<string, Partial<Record<AppOpenIntent, string>>>
>;

const FILE_NAME = "open-with-v1.json";
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
    let state: AppOpenWithPreferences = {};
    try {
      const bytes = await FS.promises.readFile(filePath);
      if (bytes.byteLength > MAX_BYTES) throw new Error("Open With state exceeds its size limit.");
      state = parsePreferences(JSON.parse(bytes.toString("utf8")));
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
    return new AppOpenWithPreferenceStore(filePath, state);
  }

  snapshot(): AppOpenWithPreferences {
    return this.#state;
  }

  get(spaceId: string, intent: AppOpenIntent): string | undefined {
    return this.#state[requireText(spaceId, "spaceId")]?.[intent];
  }

  set(
    spaceId: string,
    intent: AppOpenIntent,
    appId: string | null,
  ): Promise<AppOpenWithPreferences> {
    const operation = this.#queue.then(async () => {
      const current = { ...(this.#state[requireText(spaceId, "spaceId")] ?? {}) };
      if (appId === null) delete current[intent];
      else current[intent] = requireText(appId, "appId");
      const next = {
        ...this.#state,
        [spaceId]: current,
      };
      await writePreferences(this.#filePath, next);
      this.#state = next;
    });
    this.#queue = operation.catch(() => undefined);
    return operation.then(() => this.#state);
  }
}

function parsePreferences(value: unknown): AppOpenWithPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Open With state must be an object.");
  }
  const result: Record<string, Partial<Record<AppOpenIntent, string>>> = {};
  for (const [spaceId, raw] of Object.entries(value)) {
    requireText(spaceId, "spaceId");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Open With Space state must be an object.");
    }
    const record = raw as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key !== "open-url" && key !== "open-file" && key !== "open-directory") {
        throw new Error(`Unknown Open With intent ${key}.`);
      }
      requireText(record[key], key);
    }
    result[spaceId] = record as Partial<Record<AppOpenIntent, string>>;
  }
  return result;
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
