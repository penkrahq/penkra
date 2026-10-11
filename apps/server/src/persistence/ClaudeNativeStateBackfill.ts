// FILE: ClaudeNativeStateBackfill.ts
// Purpose: Move pre-upgrade Claude conversations into canonical native-state folders.

import { lstat, mkdir, readdir, rename, rm, rmdir } from "node:fs/promises";
import * as Path from "node:path";
import { Effect, Exit } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { claudeThreadProjectName } from "../provider/claudeThreadNativeState.ts";
import { providerNativeStateRoot } from "../provider/providerNativeStatePaths.ts";

async function directoryExists(path: string): Promise<boolean> {
  try {
    const entry = await lstat(path);
    if (!entry.isDirectory())
      throw new Error(`Claude native-state path is not a directory: ${path}`);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}

/** SQL and moved folders roll back together if the migration or any move fails. */
export const withClaudeNativeStateBackfill = <A, E, R>(
  stateDir: string,
  migration: Effect.Effect<A, E, R>,
) =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const moved: Array<{ source: string; target: string }> = [];
      const created: string[] = [];
      let removedParent = false;
      const oldParent = Path.join(stateDir, "provider-thread-native-state");
      const result = yield* Effect.exit(
        sql.withTransaction(
          Effect.gen(function* () {
            const migrations = yield* migration;
            if (!(yield* Effect.tryPromise(() => directoryExists(oldParent)))) {
              return { migrations, movedFolders: 0 };
            }
            const names = yield* Effect.tryPromise(() => readdir(oldParent));
            if (names.length === 0) {
              yield* Effect.tryPromise(async () => {
                await rmdir(oldParent);
                removedParent = true;
              });
              return { migrations, movedFolders: 0 };
            }
            const rows = yield* sql<{ id: string; nativeStateId: string | null }>`
              SELECT id, native_state_id AS "nativeStateId" FROM threads
              WHERE provider = 'claudeAgent' ORDER BY id
            `;
            const knownNames = new Set(rows.map((row) => claudeThreadProjectName(row.id)));
            const unknown = names.find((name) => !knownNames.has(name));
            if (unknown !== undefined)
              return yield* Effect.fail(
                new Error(
                  `Claude native-state folder has no thread row: ${Path.join(oldParent, unknown)}`,
                ),
              );
            for (const row of rows) {
              const source = Path.join(oldParent, claudeThreadProjectName(row.id));
              if (!(yield* Effect.tryPromise(() => directoryExists(source)))) continue;
              if (row.nativeStateId === null) {
                return yield* Effect.fail(
                  new Error(`Claude conversation has no native_state_id: ${source}`),
                );
              }
              const root = providerNativeStateRoot(stateDir, row.nativeStateId);
              const target = Path.join(root, "claude");
              yield* Effect.tryPromise({
                try: async () => {
                  try {
                    await lstat(target);
                    throw new Error(`Claude native-state target already exists: ${target}`);
                  } catch (cause) {
                    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
                  }
                  const firstCreated = await mkdir(root, { recursive: true, mode: 0o700 });
                  if (firstCreated !== undefined) created.push(firstCreated);
                  await rename(source, target);
                  moved.push({ source, target });
                },
                catch: (cause) =>
                  new Error(
                    `Could not move Claude conversation ${source} to ${target}: ${String(cause)}`,
                    { cause },
                  ),
              });
            }
            yield* Effect.tryPromise(async () => {
              await rmdir(oldParent);
              removedParent = true;
            });
            yield* Effect.logInfo("Claude native-state folders moved", {
              movedFolders: moved.length,
            });
            return { migrations, movedFolders: moved.length };
          }),
        ),
      );
      if (Exit.isSuccess(result)) return result.value;
      yield* Effect.tryPromise({
        try: async () => {
          if (removedParent) await mkdir(oldParent, { recursive: true, mode: 0o700 });
          for (const { source, target } of moved.toReversed()) await rename(target, source);
          for (const path of created.toReversed()) await rm(path, { recursive: true, force: true });
        },
        catch: (cause) =>
          new Error(`Could not roll back Claude native-state folder moves: ${String(cause)}`, {
            cause,
          }),
      });
      return yield* Effect.failCause(result.cause);
    }),
  );
