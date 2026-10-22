import { lstat } from "node:fs/promises";
import path from "node:path";
import { buildProviderChildEnvironment } from "../providerChildEnvironment.ts";

export interface OpenCodeStorage {
  readonly root: string;
  readonly database: string;
  readonly data: string;
  readonly env: NodeJS.ProcessEnv;
  readonly generationRoot?: string;
}

export async function hasOpenCodeDatabase(root: string): Promise<boolean> {
  try {
    if (!(await lstat(path.join(root, "opencode.db"))).isFile())
      throw new Error("OpenCode database is not a regular file.");
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;
    throw cause;
  }
}

export function openCodeStorage(profileRoot: string, generationRoot?: string): OpenCodeStorage {
  const root = generationRoot ?? profileRoot;
  const database = path.join(root, "opencode.db");
  const data = path.join(root, "xdg-data", "opencode");
  return {
    root,
    database,
    data,
    ...(generationRoot === undefined ? {} : { generationRoot }),
    env: buildProviderChildEnvironment({
      provider: "opencode",
      managedConnection: true,
      baseEnv: process.env,
      isolation: {
        homePath: path.join(profileRoot, "home"),
        xdgConfigHome: path.join(profileRoot, "xdg-config"),
        xdgDataHome: path.join(root, "xdg-data"),
        xdgCacheHome: path.join(profileRoot, "xdg-cache"),
        xdgStateHome: path.join(root, "xdg-state"),
      },
      overrides: { OPENCODE_DB: database, OPENCODE_CONFIG_CONTENT: "{}" },
    }),
  };
}

/** A present old database is a migration source, never a runtime fallback. */
export async function findOpenCodeStorage(
  profileRoot: string,
  generationRoot?: string,
): Promise<OpenCodeStorage | null> {
  if (generationRoot !== undefined && (await hasOpenCodeDatabase(generationRoot)))
    return openCodeStorage(profileRoot, generationRoot);
  return (await hasOpenCodeDatabase(profileRoot)) ? openCodeStorage(profileRoot) : null;
}
