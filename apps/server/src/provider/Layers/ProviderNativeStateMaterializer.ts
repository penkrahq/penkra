// FILE: ProviderNativeStateMaterializer.ts
// Purpose: Crash-safe filesystem materialization for provider-native state.

import { cp, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import * as Path from "node:path";
import { randomUUID } from "node:crypto";
import { backup as backupSqlite, DatabaseSync } from "node:sqlite";
import { Effect, Layer } from "effect";
import { startDiagnosticTrace } from "@penkra/shared/traceContext";
import { recordDiagnosticIncident } from "../../diagnostics/recorder.ts";

import { ServerConfig } from "../../config.ts";
import { providerNativeStateRoot } from "../providerNativeStatePaths.ts";
import { requireOneExactCodexRollout } from "../codexManagedNativeState.ts";
import {
  CLAUDE_SESSION_MARKER_FILE,
  claudeThreadHasConversation,
  claudeThreadStateRoot,
} from "../claudeThreadNativeState.ts";
import {
  ProviderNativeStateMaterializationError,
  ProviderNativeStateMaterializer,
  type ProviderNativeStateMaterializerShape,
} from "../Services/ProviderNativeStateMaterializer.ts";

const failure = (detail: string, cause?: unknown) => {
  recordDiagnosticIncident({
    ...startDiagnosticTrace(),
    kind: "external.failed",
    code: "EXTERNAL_CALL_FAILED",
    where: "provider.native_state",
    severity: "error",
    expected: { accepted: true },
    actual: { accepted: false },
  });
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

const CLAUDE_FORK_STATE_MANIFEST = "claude-fork-state.json";

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
    case "claudeAgent":
      throw new Error("Claude state is owned by its Thread, outside provider generations.");
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
          if (input.harness === "claudeAgent") {
            if (!input.sourceThreadId || !input.targetThreadId) {
              throw new Error("Claude native state requires source and target Thread identities.");
            }
            const sourceThreadRoot = claudeThreadStateRoot(config.stateDir, input.sourceThreadId);
            const targetThreadRoot = claudeThreadStateRoot(config.stateDir, input.targetThreadId);
            const forking = sourceThreadRoot !== targetThreadRoot;
            const hasConversation = await claudeThreadHasConversation(
              config.stateDir,
              input.sourceThreadId,
              input.providerSessionId,
            );
            // A switch keeps the Thread-owned conversation and can always rebuild
            // from Penkra's transcript, so it never fails here. A fork needs the
            // exact source conversation to copy before it can be created.
            if (!hasConversation && forking) {
              throw new Error("The exact Thread-owned Claude session is unavailable.");
            }
            let publishedForkState = false;
            const forkStaging = `${targetThreadRoot}.staging-${randomUUID()}`;
            try {
              await mkdir(staging, { mode: 0o700 });
              if (forking) {
                // An exact fork creates a different Thread. Its native state must
                // be independent; a Connection switch of one Thread never copies.
                if (await exists(targetThreadRoot)) {
                  throw new Error("The fork target Thread already owns Claude native state.");
                }
                await mkdir(Path.dirname(targetThreadRoot), { recursive: true, mode: 0o700 });
                await cp(sourceThreadRoot, forkStaging, {
                  recursive: true,
                  force: false,
                  errorOnExist: true,
                });
                await rename(forkStaging, targetThreadRoot);
                publishedForkState = true;
                await writeFile(
                  Path.join(staging, CLAUDE_FORK_STATE_MANIFEST),
                  JSON.stringify({ targetThreadId: input.targetThreadId }),
                  { mode: 0o600 },
                );
              }
              await writeFile(
                Path.join(staging, CLAUDE_SESSION_MARKER_FILE),
                JSON.stringify({
                  providerSessionId: input.providerSessionId,
                  ...(hasConversation ? {} : { requiresReconstruction: true }),
                }),
                { mode: 0o600 },
              );
              await rename(staging, target);
              return target;
            } catch (cause) {
              await rm(forkStaging, { recursive: true, force: true });
              if (publishedForkState) {
                await rm(targetThreadRoot, { recursive: true, force: true });
              }
              await rm(staging, { recursive: true, force: true });
              throw cause;
            }
          }
          const sourceStat = await lstat(generationSource);
          if (!sourceStat.isDirectory()) {
            throw new Error("source generation is not a directory");
          }
          try {
            await mkdir(staging, { mode: 0o700 });
            if (input.harness === "opencode") {
              await snapshotOpenCodeDatabase(generationSource, staging);
            }
            const entries = await exactNativeEntries({
              harness: input.harness,
              providerSessionId: input.providerSessionId,
              sourceRoot: generationSource,
            });
            for (const entry of entries) await copyEntry(generationSource, staging, entry);
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

  const discard: ProviderNativeStateMaterializerShape["discard"] = (generationId) =>
    Effect.tryPromise({
      try: async () => {
        const generationRoot = providerNativeStateRoot(config.stateDir, generationId);
        const forkManifest = await readFile(
          Path.join(generationRoot, CLAUDE_FORK_STATE_MANIFEST),
          "utf8",
        ).catch((cause: NodeJS.ErrnoException) => {
          if (cause.code === "ENOENT") return null;
          throw cause;
        });
        if (forkManifest !== null) {
          const decoded: unknown = JSON.parse(forkManifest);
          if (
            typeof decoded !== "object" ||
            decoded === null ||
            !("targetThreadId" in decoded) ||
            typeof decoded.targetThreadId !== "string"
          )
            throw new Error("Claude fork state manifest is invalid.");
          await rm(claudeThreadStateRoot(config.stateDir, decoded.targetThreadId), {
            recursive: true,
            force: true,
          });
        }
        await rm(generationRoot, {
          recursive: true,
          force: true,
        });
      },
      catch: (cause) =>
        failure("Could not discard an uncommitted provider-native state generation.", cause),
    });

  const finalize: ProviderNativeStateMaterializerShape["finalize"] = (generationId) =>
    Effect.tryPromise({
      try: async () => {
        const generationRoot = providerNativeStateRoot(config.stateDir, generationId);
        await rm(Path.join(generationRoot, CLAUDE_FORK_STATE_MANIFEST), { force: true });
      },
      catch: (cause) => failure("Could not finalize the provider-native state generation.", cause),
    });

  const discardThreadState: ProviderNativeStateMaterializerShape["discardThreadState"] = (
    threadId,
  ) =>
    Effect.tryPromise({
      try: () =>
        rm(claudeThreadStateRoot(config.stateDir, threadId), {
          recursive: true,
          force: true,
        }),
      catch: (cause) => failure("Could not discard a Thread's owned Claude state.", cause),
    });

  return {
    clone,
    discard,
    finalize,
    discardThreadState,
  } satisfies ProviderNativeStateMaterializerShape;
});

export const ProviderNativeStateMaterializerLive = Layer.effect(
  ProviderNativeStateMaterializer,
  makeProviderNativeStateMaterializer,
);
