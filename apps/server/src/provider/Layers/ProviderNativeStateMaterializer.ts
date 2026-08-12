// FILE: ProviderNativeStateMaterializer.ts
// Purpose: Crash-safe filesystem materialization for provider-native state.

import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import * as Path from "node:path";
import { randomUUID } from "node:crypto";
import { Effect, Layer } from "effect";

import { ServerConfig } from "../../config.ts";
import {
  providerConnectionProfileRoot,
  providerNativeStateRoot,
} from "../providerNativeStatePaths.ts";
import { requireOneExactCodexRollout } from "../codexManagedNativeState.ts";
import {
  ProviderNativeStateMaterializationError,
  ProviderNativeStateMaterializer,
  type ProviderNativeStateMaterializerShape,
} from "../Services/ProviderNativeStateMaterializer.ts";

const failure = (detail: string, cause?: unknown) =>
  new ProviderNativeStateMaterializationError({
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

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

class TargetSessionConflictError extends Error {}

async function assertEntriesEqual(source: string, target: string): Promise<void> {
  const [sourceStat, targetStat] = await Promise.all([lstat(source), lstat(target)]);
  if (sourceStat.isFile() && targetStat.isFile()) {
    const [sourceBytes, targetBytes] = await Promise.all([readFile(source), readFile(target)]);
    if (!sourceBytes.equals(targetBytes))
      throw new TargetSessionConflictError("Target session artifact conflicts.");
    return;
  }
  if (sourceStat.isDirectory() && targetStat.isDirectory()) {
    const [sourceNames, targetNames] = await Promise.all([readdir(source), readdir(target)]);
    sourceNames.sort();
    targetNames.sort();
    if (sourceNames.join("\0") !== targetNames.join("\0")) {
      throw new TargetSessionConflictError("Target session directory conflicts.");
    }
    await Promise.all(
      sourceNames.map((name) =>
        assertEntriesEqual(Path.join(source, name), Path.join(target, name)),
      ),
    );
    return;
  }
  throw new TargetSessionConflictError("Target session artifact has a different filesystem type.");
}

const CLAUDE_PROFILE_ROLLBACK_DIRECTORY = "claude-profile-rollback";
const CLAUDE_PROFILE_ROLLBACK_MANIFEST = "claude-profile-rollback.json";

type ClaudeProfileMutation = {
  readonly relativePath: string;
  readonly previous: "missing" | "preserved";
};

type ClaudeProfileRollbackManifest = {
  readonly targetConnectionId: string;
  readonly mutations: ClaudeProfileMutation[];
};

function resolveProfileEntry(root: string, relativePath: string): string {
  const target = Path.join(root, relativePath);
  const relative = Path.relative(root, target);
  if (relative === "" || relative.startsWith("..") || Path.isAbsolute(relative)) {
    throw new Error("Provider-native state entry escaped its Connection profile.");
  }
  return target;
}

async function synchronizeClaudeSessionEntry(input: {
  readonly sourceRoot: string;
  readonly targetRoot: string;
  readonly rollbackRoot: string;
  readonly source: string;
}): Promise<ClaudeProfileMutation | null> {
  const relativePath = Path.relative(input.sourceRoot, input.source);
  const target = resolveProfileEntry(input.targetRoot, relativePath);
  if (!(await exists(target))) {
    await copyEntry(input.sourceRoot, input.targetRoot, input.source);
    return { relativePath, previous: "missing" };
  }

  try {
    await assertEntriesEqual(input.source, target);
    return null;
  } catch (cause) {
    if (!(cause instanceof TargetSessionConflictError)) throw cause;
  }

  const backup = resolveProfileEntry(input.rollbackRoot, relativePath);
  await mkdir(Path.dirname(backup), { recursive: true, mode: 0o700 });
  await rename(target, backup);
  try {
    await copyEntry(input.sourceRoot, input.targetRoot, input.source);
  } catch (cause) {
    await mkdir(Path.dirname(target), { recursive: true, mode: 0o700 });
    await rename(backup, target);
    throw cause;
  }
  return { relativePath, previous: "preserved" };
}

async function rollbackClaudeProfileMutations(input: {
  readonly generationRoot: string;
  readonly targetProfile: string;
  readonly mutations: readonly ClaudeProfileMutation[];
}): Promise<void> {
  const rollbackRoot = Path.join(input.generationRoot, CLAUDE_PROFILE_ROLLBACK_DIRECTORY);
  for (const mutation of [...input.mutations].reverse()) {
    const target = resolveProfileEntry(input.targetProfile, mutation.relativePath);
    if (mutation.previous === "missing") {
      await rm(target, { recursive: true, force: true });
      continue;
    }
    const backup = resolveProfileEntry(rollbackRoot, mutation.relativePath);
    await rm(target, { recursive: true, force: true });
    await mkdir(Path.dirname(target), { recursive: true, mode: 0o700 });
    await rename(backup, target);
  }
}

async function readClaudeRollbackManifest(
  generationRoot: string,
): Promise<ClaudeProfileRollbackManifest | null> {
  const raw = await readFile(
    Path.join(generationRoot, CLAUDE_PROFILE_ROLLBACK_MANIFEST),
    "utf8",
  ).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return null;
    throw cause;
  });
  if (raw === null) return null;
  const decoded = JSON.parse(raw) as Partial<ClaudeProfileRollbackManifest>;
  if (
    typeof decoded.targetConnectionId !== "string" ||
    !Array.isArray(decoded.mutations) ||
    decoded.mutations.some(
      (mutation) =>
        typeof mutation !== "object" ||
        mutation === null ||
        typeof mutation.relativePath !== "string" ||
        (mutation.previous !== "missing" && mutation.previous !== "preserved"),
    )
  ) {
    throw new Error("Claude profile rollback metadata is invalid.");
  }
  return decoded as ClaudeProfileRollbackManifest;
}

async function collectExactClaudeSessionFiles(
  root: string,
  providerSessionId: string,
): Promise<string[]> {
  const matches: string[] = [];
  const projectsRoot = Path.join(root, "claude-config", "projects");
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(
      (cause: NodeJS.ErrnoException) => {
        if (cause.code === "ENOENT") return [];
        throw cause;
      },
    )) {
      const entryPath = Path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile() && entry.name === `${providerSessionId}.jsonl`) {
        matches.push(entryPath);
      }
    }
  };
  await visit(projectsRoot);
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? "The exact Claude session is unavailable."
        : "More than one exact Claude session exists.",
    );
  }
  const exact = matches[0]!;
  const entries = [exact];
  for (const optional of [
    exact.slice(0, -".jsonl".length),
    Path.join(root, "claude-config", "session-env", providerSessionId),
    Path.join(root, "claude-config", "tasks", providerSessionId),
  ]) {
    if (await exists(optional)) entries.push(optional);
  }
  return entries;
}

const OPEN_CODE_NATIVE_ENTRIES = ["snapshot", "storage", "tool-output", "repos", "plan"] as const;

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
      return collectExactClaudeSessionFiles(input.sourceRoot, input.providerSessionId);
    case "opencode": {
      const entries: string[] = [];
      for (const suffix of ["", "-wal", "-shm"] as const) {
        const database = Path.join(input.sourceRoot, `opencode.db${suffix}`);
        if (await exists(database)) entries.push(database);
      }
      if (!entries.some((entry) => entry.endsWith("opencode.db"))) {
        throw new Error("The exact OpenCode database is unavailable.");
      }
      for (const name of OPEN_CODE_NATIVE_ENTRIES) {
        const entry = Path.join(input.sourceRoot, "xdg-data", "opencode", name);
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

  const clone: ProviderNativeStateMaterializerShape["clone"] = (input) =>
    Effect.tryPromise({
      try: async () => {
        if (input.sourceGenerationId === input.targetGenerationId) {
          throw new Error("source and target generations are identical");
        }
        const generationSource = providerNativeStateRoot(config.stateDir, input.sourceGenerationId);
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
          if (
            (input.sourceStorage === "connection-profile" && input.sourceConnectionId === null) ||
            input.targetConnectionId === null
          ) {
            throw new Error("Claude native state requires exact source and target storage.");
          }
          const sourceProfile =
            input.sourceStorage === "generation"
              ? generationSource
              : providerConnectionProfileRoot(config.stateDir, input.sourceConnectionId!);
          const targetProfile = providerConnectionProfileRoot(
            config.stateDir,
            input.targetConnectionId,
          );
          const mutations: ClaudeProfileMutation[] = [];
          try {
            await mkdir(staging, { mode: 0o700 });
            const entries = await collectExactClaudeSessionFiles(
              sourceProfile,
              input.providerSessionId,
            );
            if (sourceProfile !== targetProfile) {
              for (const entry of entries) {
                const mutation = await synchronizeClaudeSessionEntry({
                  sourceRoot: sourceProfile,
                  targetRoot: targetProfile,
                  rollbackRoot: Path.join(staging, CLAUDE_PROFILE_ROLLBACK_DIRECTORY),
                  source: entry,
                });
                if (mutation !== null) mutations.push(mutation);
              }
            }
            await writeFile(
              Path.join(staging, CLAUDE_PROFILE_ROLLBACK_MANIFEST),
              JSON.stringify({
                targetConnectionId: input.targetConnectionId,
                mutations,
              } satisfies ClaudeProfileRollbackManifest),
              { mode: 0o600 },
            );
            await writeFile(
              Path.join(staging, "claude-session.json"),
              JSON.stringify({ providerSessionId: input.providerSessionId }),
              { mode: 0o600 },
            );
            await rename(staging, target);
            return target;
          } catch (cause) {
            await rollbackClaudeProfileMutations({
              generationRoot: staging,
              targetProfile,
              mutations,
            }).catch(() => undefined);
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

  const discard: ProviderNativeStateMaterializerShape["discard"] = (generationId) =>
    Effect.tryPromise({
      try: async () => {
        const generationRoot = providerNativeStateRoot(config.stateDir, generationId);
        const manifest = await readClaudeRollbackManifest(generationRoot);
        if (manifest !== null) {
          await rollbackClaudeProfileMutations({
            generationRoot,
            targetProfile: providerConnectionProfileRoot(
              config.stateDir,
              manifest.targetConnectionId,
            ),
            mutations: manifest.mutations,
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
        await rm(Path.join(generationRoot, CLAUDE_PROFILE_ROLLBACK_DIRECTORY), {
          recursive: true,
          force: true,
        });
        await rm(Path.join(generationRoot, CLAUDE_PROFILE_ROLLBACK_MANIFEST), { force: true });
      },
      catch: (cause) => failure("Could not finalize the provider-native state generation.", cause),
    });

  return { clone, discard, finalize } satisfies ProviderNativeStateMaterializerShape;
});

export const ProviderNativeStateMaterializerLive = Layer.effect(
  ProviderNativeStateMaterializer,
  makeProviderNativeStateMaterializer,
);
