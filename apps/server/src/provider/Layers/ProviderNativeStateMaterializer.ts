// FILE: ProviderNativeStateMaterializer.ts
// Purpose: Crash-safe filesystem materialization for provider-native state.

import { cp, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import * as Path from "node:path";
import { randomUUID } from "node:crypto";
import { backup as backupSqlite, DatabaseSync } from "node:sqlite";
import { Effect, Layer } from "effect";

import { ServerConfig } from "../../config.ts";
import { providerNativeStateRoot } from "../providerNativeStatePaths.ts";
import { requireOneExactCodexRollout } from "../codexManagedNativeState.ts";
import {
  CLAUDE_SESSION_MARKER_FILE,
  claudeProjectHasConversation,
  claudeNativeProjectRoot,
} from "../claudeThreadNativeState.ts";
import {
  ProviderNativeStateMaterializationError,
  ProviderNativeStateMaterializer,
  type ProviderNativeStateMaterializerShape,
} from "../Services/ProviderNativeStateMaterializer.ts";

const failure = (detail: string, cause?: unknown) => {
  return new ProviderNativeStateMaterializationError({
    detail,
    ...(cause === undefined ? {} : { cause }),
  });
};

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}

async function copyEntry(sourceRoot: string, targetRoot: string, source: string): Promise<void> {
  const relative = Path.relative(sourceRoot, source);
  if (relative === "" || relative.startsWith("..") || Path.isAbsolute(relative)) {
    throw new Error("Provider-native state entry escaped its generation.");
  }
  const target = Path.join(targetRoot, relative);
  await mkdir(Path.dirname(target), { recursive: true, mode: 0o700 });
  await cp(source, target, {
    recursive: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
}

const OPEN_CODE_NATIVE_ENTRIES = ["snapshot", "storage", "tool-output", "repos", "plan"] as const;

async function snapshotOpenCodeDatabase(sourceRoot: string, targetRoot: string): Promise<void> {
  const sourcePath = Path.join(sourceRoot, "opencode.db");
  if (!(await exists(sourcePath))) {
    throw new Error("The exact OpenCode database is unavailable.");
  }
  const targetPath = Path.join(targetRoot, "opencode.db");
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    // SQLite's online backup API produces one transactionally consistent
    // database even while the source is in WAL mode. Raw db/wal/shm copying
    // cannot provide that guarantee while OpenCode's pooled server is alive.
    await backupSqlite(source, targetPath);
  } finally {
    source.close();
  }
}

async function exactNativeEntries(input: {
  readonly harness: Parameters<ProviderNativeStateMaterializerShape["clone"]>[0]["harness"];
  readonly providerSessionId: string;
  readonly sourceRoot: string;
}): Promise<string[]> {
  switch (input.harness) {
    case "codex":
      return [
        await requireOneExactCodexRollout(
          Path.join(input.sourceRoot, "codex-rollouts"),
          input.providerSessionId,
        ),
      ];
    case "claudeAgent": {
      const entries: string[] = [];
      for (const name of ["project", "session-env", "tasks", "file-history"]) {
        const entry = Path.join(input.sourceRoot, name);
        if (await exists(entry)) entries.push(entry);
      }
      return entries;
    }
    case "opencode": {
      const entries: string[] = [];
      for (const name of OPEN_CODE_NATIVE_ENTRIES) {
        const entry = Path.join(input.sourceRoot, "xdg-data", "opencode", name);
        if (await exists(entry)) entries.push(entry);
      }
      const stateRoot = Path.join(input.sourceRoot, "xdg-state");
      if (await exists(stateRoot)) entries.push(stateRoot);
      return entries;
    }
    default:
      throw new Error(`Managed native-state cloning is unsupported for ${input.harness}.`);
  }
}

export const makeProviderNativeStateMaterializer = Effect.gen(function* () {
  const config = yield* ServerConfig;

  const clone: ProviderNativeStateMaterializerShape["clone"] = (input) =>
    Effect.gen(function* () {
      return yield* Effect.tryPromise({
        try: async () => {
          if (input.sourceGenerationId === input.targetGenerationId) {
            throw new Error("source and target generations are identical");
          }
          const generationSource = providerNativeStateRoot(
            config.stateDir,
            input.sourceGenerationId,
          );
          const target = providerNativeStateRoot(config.stateDir, input.targetGenerationId);
          const parent = Path.dirname(target);
          const staging = Path.join(parent, `.staging-${Path.basename(target)}-${randomUUID()}`);
          await mkdir(parent, { recursive: true, mode: 0o700 });
          try {
            await lstat(target);
            throw new Error("target generation already exists");
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
              throw cause;
            }
          }
          const sourceExists = await exists(generationSource);
          if (sourceExists && !(await lstat(generationSource)).isDirectory()) {
            throw new Error("source generation is not a directory");
          }
          if (!sourceExists && input.harness !== "claudeAgent") {
            throw new Error(`The provider-native state folder is missing: ${generationSource}`);
          }
          try {
            await mkdir(staging, { mode: 0o700 });
            if (input.harness === "opencode") {
              await snapshotOpenCodeDatabase(generationSource, staging);
            }
            const sourceRoot =
              input.harness === "claudeAgent"
                ? await claudeNativeProjectRoot(generationSource)
                : generationSource;
            const copyTarget =
              input.harness === "claudeAgent" ? Path.join(staging, "claude") : staging;
            const requiresReconstruction =
              input.harness === "claudeAgent" &&
              !(await claudeProjectHasConversation(sourceRoot, input.providerSessionId));
            const entries = requiresReconstruction
              ? []
              : await exactNativeEntries({
                  harness: input.harness,
                  providerSessionId: input.providerSessionId,
                  sourceRoot,
                });
            for (const entry of entries) await copyEntry(sourceRoot, copyTarget, entry);
            if (input.harness === "claudeAgent") {
              await writeFile(
                Path.join(staging, CLAUDE_SESSION_MARKER_FILE),
                JSON.stringify({
                  providerSessionId: input.providerSessionId,
                  ...(requiresReconstruction ? { requiresReconstruction: true } : {}),
                }),
                { mode: 0o600 },
              );
            }
            await rename(staging, target);
          } catch (cause) {
            await rm(staging, { recursive: true, force: true });
            throw cause;
          }
          return target;
        },
        catch: (cause) =>
          failure("Could not materialize the exact provider-native state generation.", cause),
      });
    });

  const discard: ProviderNativeStateMaterializerShape["discard"] = (nativeStateId) =>
    Effect.tryPromise({
      try: () =>
        rm(providerNativeStateRoot(config.stateDir, nativeStateId), {
          recursive: true,
          force: true,
        }),
      catch: (cause) =>
        failure("Could not discard an uncommitted provider-native state folder.", cause),
    });

  return { clone, discard } satisfies ProviderNativeStateMaterializerShape;
});

export const ProviderNativeStateMaterializerLive = Layer.effect(
  ProviderNativeStateMaterializer,
  makeProviderNativeStateMaterializer,
);
