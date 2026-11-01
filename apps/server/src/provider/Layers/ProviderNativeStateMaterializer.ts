// FILE: ProviderNativeStateMaterializer.ts
// Purpose: Crash-safe filesystem materialization for provider-native state.

import { cp, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import * as Path from "node:path";
import { randomUUID } from "node:crypto";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { providerNativeStateRoot, providerOpaquePathKey } from "../providerNativeStatePaths.ts";
import { findOneExactCodexRollout } from "../codexManagedNativeState.ts";
import {
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
    throw new Error("Provider-native state entry escaped its native-state folder.");
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

async function exactNativeEntries(input: {
  readonly harness: Parameters<ProviderNativeStateMaterializerShape["clone"]>[0]["harness"];
  readonly providerSessionId: string;
  readonly sourceRoot: string;
}): Promise<string[] | null> {
  switch (input.harness) {
    case "codex": {
      const rollout = await findOneExactCodexRollout(
        Path.join(input.sourceRoot, "codex-rollouts"),
        input.providerSessionId,
      );
      return rollout === null ? null : [rollout];
    }
    case "claudeAgent": {
      const entries: string[] = [];
      for (const name of ["project", "session-env", "tasks", "file-history"]) {
        const entry = Path.join(input.sourceRoot, name);
        if (await exists(entry)) entries.push(entry);
      }
      return entries;
    }
    default:
      throw new Error(`Managed native-state cloning is unsupported for ${input.harness}.`);
  }
}

export const makeProviderNativeStateMaterializer = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const sql = yield* SqlClient.SqlClient;

  // Run before admitting turns. The database owner lock prevents another server
  // from creating generations while this process starts.
  const referenced = new Set<string>();
  let after = "";
  for (;;) {
    const rows = yield* sql<{
      id: string;
      nativeStateId: string | null;
    }>`SELECT id,native_state_id AS "nativeStateId" FROM threads WHERE id>${after} ORDER BY id LIMIT 500`;
    for (const row of rows)
      if (row.nativeStateId !== null) referenced.add(providerOpaquePathKey(row.nativeStateId));
    if (rows.length < 500) break;
    after = rows[rows.length - 1]!.id;
  }
  const stateRoot = Path.join(config.stateDir, "provider-native-state");
  const names = yield* Effect.tryPromise({
    try: () => readdir(stateRoot),
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) => {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return Effect.succeed([] as string[]);
      return Effect.logError("provider.storage.sweep-failed", { path: stateRoot, cause }).pipe(
        Effect.as([] as string[]),
      );
    }),
  );
  for (const name of names) {
    if (!/^[a-f0-9]{64}$/.test(name) || referenced.has(name)) continue;
    const path = Path.join(stateRoot, name);
    yield* Effect.tryPromise({
      try: () => rm(path, { recursive: true, force: true }),
      catch: (cause) => cause,
    }).pipe(
      Effect.catch((cause) => Effect.logError("provider.storage.discard-failed", { path, cause })),
    );
  }

  const clone: ProviderNativeStateMaterializerShape["clone"] = (input) =>
    Effect.gen(function* () {
      return yield* Effect.tryPromise({
        try: async () => {
          if (input.sourceNativeStateId === input.targetNativeStateId) {
            throw new Error("source and target native-state folders are identical");
          }
          const source =
            input.sourceNativeStateId === null
              ? null
              : providerNativeStateRoot(config.stateDir, input.sourceNativeStateId);
          const target = providerNativeStateRoot(config.stateDir, input.targetNativeStateId);
          const parent = Path.dirname(target);
          const staging = Path.join(parent, `.staging-${Path.basename(target)}-${randomUUID()}`);
          await mkdir(parent, { recursive: true, mode: 0o700 });
          try {
            await lstat(target);
            throw new Error("target native-state folder already exists");
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
              throw cause;
            }
          }
          const sourceExists = source !== null && (await exists(source));
          if (source !== null && sourceExists && !(await lstat(source)).isDirectory()) {
            throw new Error("source native-state folder is not a directory");
          }
          let providerSessionId = input.providerSessionId;
          try {
            await mkdir(staging, { mode: 0o700 });
            if (!sourceExists || source === null || providerSessionId === null) {
              providerSessionId = null;
              await rename(staging, target);
              return { root: target, providerSessionId };
            }
            const sourceRoot =
              input.harness === "claudeAgent" ? await claudeNativeProjectRoot(source) : source;
            const copyTarget =
              input.harness === "claudeAgent" ? Path.join(staging, "claude") : staging;
            const missingConversation =
              input.harness === "claudeAgent" &&
              !(await claudeProjectHasConversation(sourceRoot, providerSessionId));
            const entries = missingConversation
              ? []
              : await exactNativeEntries({
                  harness: input.harness,
                  providerSessionId,
                  sourceRoot,
                });
            if (entries !== null) {
              for (const entry of entries) await copyEntry(sourceRoot, copyTarget, entry);
            }
            if (missingConversation || entries === null) providerSessionId = null;
            await rename(staging, target);
          } catch (cause) {
            await rm(staging, { recursive: true, force: true });
            throw cause;
          }
          return { root: target, providerSessionId };
        },
        catch: (cause) =>
          failure("Could not materialize the exact provider-native state folder.", cause),
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
