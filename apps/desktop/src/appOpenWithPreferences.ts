// FILE: appOpenWithPreferences.ts
// Purpose: Persists the deterministic device-wide Open With choice for URLs.
// Layer: Trusted desktop App routing state

import * as FS from "node:fs";
import * as Path from "node:path";

export type AppOpenIntent = "open-url";
export interface AppOpenWithPreferences {
  "open-url"?: string;
}

const FILE_NAME = "open-with-v3.json";
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

  forSpace(spaceId: string): AppOpenWithPreferences {
    requireText(spaceId, "spaceId");
    return this.#state;
  }

  get(spaceId: string, intent: AppOpenIntent): string | undefined {
    return this.forSpace(spaceId)[intent];
  }

  set(
    spaceId: string,
    intent: AppOpenIntent,
    appId: string | null,
  ): Promise<AppOpenWithPreferences> {
    requireText(spaceId, "spaceId");
    const operation = this.#queue.then(async () => {
      const next = { ...this.#state };
      if (appId === null) delete next[intent];
      else next[intent] = requireText(appId, "appId");
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
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "open-url") throw new Error(`Unknown Open With preference ${key}.`);
  }
  return record["open-url"] === undefined
    ? {}
    : { "open-url": requireText(record["open-url"], "open-url") };
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
