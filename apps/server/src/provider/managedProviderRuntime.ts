import type { ProviderKind } from "@penkra/contracts";
import { readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";

import { writeFileStringAtomically } from "../atomicWrite";

const MANAGED_PROVIDER_RUNTIME_SCHEMA_VERSION = 2;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface ManagedProviderRuntimeVersion {
  readonly installationId: string;
  readonly version: string;
  readonly executableRelativePath: string;
  readonly activatedAt: string;
}

interface ManagedProviderRuntimeActivation {
  readonly schemaVersion: typeof MANAGED_PROVIDER_RUNTIME_SCHEMA_VERSION;
  readonly provider: ProviderKind;
  readonly active: ManagedProviderRuntimeVersion;
  readonly previous: ManagedProviderRuntimeVersion | null;
  readonly rejected: ManagedProviderRuntimeVersion | null;
}

export interface ResolvedProviderBinary {
  readonly binaryPath: string;
  readonly ownership: "managed";
  readonly installationId: string;
  readonly version: string;
}

export function resolveManagedProviderRuntimeRoot(input: {
  readonly stateDir: string;
  readonly provider: ProviderKind;
}): string {
  return `${input.stateDir}/provider-runtimes/${input.provider}`;
}

export function resolveManagedProviderVersionDirectory(input: {
  readonly stateDir: string;
  readonly provider: ProviderKind;
  readonly version: string;
}): string {
  if (!SAFE_PATH_SEGMENT.test(input.version)) {
    throw new Error(`Invalid managed provider version '${input.version}'.`);
  }
  return `${resolveManagedProviderRuntimeRoot(input)}/versions/${input.version}`;
}

function activationPath(input: { readonly stateDir: string; readonly provider: ProviderKind }) {
  return `${resolveManagedProviderRuntimeRoot(input)}/activation.json`;
}

function pruneManagedProviderVersionDirectories(input: {
  readonly stateDir: string;
  readonly provider: ProviderKind;
  readonly retainedVersions: ReadonlySet<string>;
}) {
  return Effect.tryPromise({
    try: async () => {
      const versionsRoot = `${resolveManagedProviderRuntimeRoot(input)}/versions`;
      let entries: ReadonlyArray<{ readonly name: string; readonly isDirectory: () => boolean }>;
      try {
        entries = await readdir(versionsRoot, { withFileTypes: true });
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
        throw cause;
      }
      await Promise.all(
        entries
          .filter(
            (entry) =>
              entry.isDirectory() &&
              SAFE_PATH_SEGMENT.test(entry.name) &&
              !input.retainedVersions.has(entry.name),
          )
          .map((entry) =>
            rm(path.join(versionsRoot, entry.name), { recursive: true, force: true }),
          ),
      );
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });
}

function isRuntimeVersion(value: unknown): value is ManagedProviderRuntimeVersion {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ManagedProviderRuntimeVersion>;
  return (
    typeof candidate.installationId === "string" &&
    SAFE_PATH_SEGMENT.test(candidate.installationId) &&
    typeof candidate.version === "string" &&
    SAFE_PATH_SEGMENT.test(candidate.version) &&
    typeof candidate.executableRelativePath === "string" &&
    candidate.executableRelativePath.length > 0 &&
    typeof candidate.activatedAt === "string"
  );
}

function parseActivation(
  provider: ProviderKind,
  raw: string,
): ManagedProviderRuntimeActivation | null {
  try {
    const parsed = JSON.parse(raw) as {
      readonly schemaVersion?: number;
      readonly provider?: ProviderKind;
      readonly active?: ManagedProviderRuntimeVersion;
      readonly previous?: ManagedProviderRuntimeVersion | null;
      readonly rejected?: ManagedProviderRuntimeVersion | null;
    };
    if (
      (parsed.schemaVersion !== 1 &&
        parsed.schemaVersion !== MANAGED_PROVIDER_RUNTIME_SCHEMA_VERSION) ||
      parsed.provider !== provider ||
      !isRuntimeVersion(parsed.active) ||
      (parsed.previous !== null && !isRuntimeVersion(parsed.previous)) ||
      (parsed.schemaVersion === MANAGED_PROVIDER_RUNTIME_SCHEMA_VERSION &&
        parsed.rejected !== null &&
        !isRuntimeVersion(parsed.rejected))
    ) {
      return null;
    }
    return {
      schemaVersion: MANAGED_PROVIDER_RUNTIME_SCHEMA_VERSION,
      provider,
      active: parsed.active,
      previous: parsed.previous ?? null,
      rejected:
        parsed.schemaVersion === MANAGED_PROVIDER_RUNTIME_SCHEMA_VERSION
          ? (parsed.rejected ?? null)
          : null,
    } as ManagedProviderRuntimeActivation;
  } catch {
    return null;
  }
}

function resolveVersionExecutable(input: {
  readonly stateDir: string;
  readonly provider: ProviderKind;
  readonly runtime: ManagedProviderRuntimeVersion;
}) {
  return Effect.tryPromise({
    try: async () => {
      const versionDirectory = path.resolve(
        resolveManagedProviderVersionDirectory({
          stateDir: input.stateDir,
          provider: input.provider,
          version: input.runtime.version,
        }),
      );
      const executablePath = path.resolve(versionDirectory, input.runtime.executableRelativePath);
      try {
        const [realVersionDirectory, realExecutablePath] = await Promise.all([
          realpath(versionDirectory),
          realpath(executablePath),
        ]);
        const relative = path.relative(realVersionDirectory, realExecutablePath);
        if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
        return executablePath;
      } catch {
        return null;
      }
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });
}

export function readManagedProviderRuntimeActivation(input: {
  readonly stateDir: string;
  readonly provider: ProviderKind;
}) {
  return Effect.tryPromise({
    try: async () => {
      try {
        return parseActivation(input.provider, await readFile(activationPath(input), "utf8"));
      } catch {
        return null;
      }
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });
}

export function activateManagedProviderRuntime(input: {
  readonly stateDir: string;
  readonly provider: ProviderKind;
  readonly installationId: string;
  readonly version: string;
  readonly executablePath: string;
  readonly activatedAt?: string;
}) {
  return Effect.gen(function* () {
    const versionDirectory = path.resolve(
      resolveManagedProviderVersionDirectory({
        stateDir: input.stateDir,
        provider: input.provider,
        version: input.version,
      }),
    );
    const executablePath = path.resolve(input.executablePath);
    const relative = path.relative(versionDirectory, executablePath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      return yield* Effect.fail(
        new Error("Managed provider executable must be inside its version directory."),
      );
    }
    const executableExists = yield* Effect.tryPromise({
      try: async () => (await stat(executablePath)).isFile(),
      catch: () => false,
    });
    if (!executableExists) {
      return yield* Effect.fail(
        new Error(`Managed provider executable does not exist: ${executablePath}`),
      );
    }
    const [realVersionDirectory, realExecutablePath] = yield* Effect.tryPromise({
      try: () => Promise.all([realpath(versionDirectory), realpath(executablePath)]),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    });
    const realRelative = path.relative(realVersionDirectory, realExecutablePath);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      return yield* Effect.fail(
        new Error("Managed provider executable symlink must remain inside its version directory."),
      );
    }

    const current = yield* readManagedProviderRuntimeActivation(input);
    const active: ManagedProviderRuntimeVersion = {
      installationId: input.installationId,
      version: input.version,
      executableRelativePath: relative,
      activatedAt: input.activatedAt ?? new Date().toISOString(),
    };
    const previous =
      current?.active.installationId === active.installationId
        ? current.previous
        : (current?.active ?? null);
    if (current?.rejected?.installationId === active.installationId) {
      yield* pruneManagedProviderVersionDirectories({
        stateDir: input.stateDir,
        provider: input.provider,
        retainedVersions: new Set([current.active.version]),
      });
      return yield* Effect.fail(
        new Error(
          `Managed provider installation '${active.installationId}' previously failed continuation verification.`,
        ),
      );
    }
    const next: ManagedProviderRuntimeActivation = {
      schemaVersion: MANAGED_PROVIDER_RUNTIME_SCHEMA_VERSION,
      provider: input.provider,
      active,
      previous,
      rejected:
        current?.active.installationId === active.installationId
          ? (current.rejected ?? null)
          : null,
    };
    yield* writeFileStringAtomically({
      filePath: activationPath(input),
      contents: `${JSON.stringify(next, null, 2)}\n`,
    });
    yield* pruneManagedProviderVersionDirectories({
      stateDir: input.stateDir,
      provider: input.provider,
      retainedVersions: new Set(
        previous === null ? [active.version] : [active.version, previous.version],
      ),
    });
    return next;
  });
}

/**
 * Drops the one retained predecessor after the active runtime has proven that
 * it can resume provider-native state created by that predecessor.
 */
export function confirmManagedProviderRuntimeCompatibility(input: {
  readonly stateDir: string;
  readonly provider: ProviderKind;
  readonly installationId: string;
}) {
  return Effect.gen(function* () {
    const current = yield* readManagedProviderRuntimeActivation(input);
    if (!current || current.active.installationId !== input.installationId) return false;
    if (current.previous === null) return true;
    const next: ManagedProviderRuntimeActivation = { ...current, previous: null };
    yield* writeFileStringAtomically({
      filePath: activationPath(input),
      contents: `${JSON.stringify(next, null, 2)}\n`,
    });
    yield* pruneManagedProviderVersionDirectories({
      stateDir: input.stateDir,
      provider: input.provider,
      retainedVersions: new Set([current.active.version]),
    });
    return true;
  });
}

export function rollbackManagedProviderRuntime(input: {
  readonly stateDir: string;
  readonly provider: ProviderKind;
  readonly activatedAt?: string;
}) {
  return Effect.gen(function* () {
    const current = yield* readManagedProviderRuntimeActivation(input);
    if (!current?.previous) return false;
    const previousExecutable = yield* resolveVersionExecutable({
      ...input,
      runtime: current.previous,
    });
    if (!previousExecutable) return false;

    const next: ManagedProviderRuntimeActivation = {
      schemaVersion: MANAGED_PROVIDER_RUNTIME_SCHEMA_VERSION,
      provider: input.provider,
      active: {
        ...current.previous,
        activatedAt: input.activatedAt ?? new Date().toISOString(),
      },
      previous: current.active,
      rejected: current.rejected,
    };
    yield* writeFileStringAtomically({
      filePath: activationPath(input),
      contents: `${JSON.stringify(next, null, 2)}\n`,
    });
    return true;
  });
}

/**
 * Rejects an active candidate that could not resume predecessor-native state.
 * The predecessor becomes active again, the bad candidate is no longer kept on
 * disk, and re-activating that exact immutable installation is refused.
 */
export function rejectManagedProviderRuntimeUpdate(input: {
  readonly stateDir: string;
  readonly provider: ProviderKind;
  readonly installationId: string;
  readonly rejectedAt?: string;
}) {
  return Effect.gen(function* () {
    const current = yield* readManagedProviderRuntimeActivation(input);
    if (!current?.previous || current.active.installationId !== input.installationId) {
      return false;
    }
    const previousExecutable = yield* resolveVersionExecutable({
      ...input,
      runtime: current.previous,
    });
    if (!previousExecutable) return false;
    const rejected = {
      ...current.active,
      activatedAt: input.rejectedAt ?? new Date().toISOString(),
    };
    const next: ManagedProviderRuntimeActivation = {
      schemaVersion: MANAGED_PROVIDER_RUNTIME_SCHEMA_VERSION,
      provider: input.provider,
      active: {
        ...current.previous,
        activatedAt: input.rejectedAt ?? new Date().toISOString(),
      },
      previous: null,
      rejected,
    };
    yield* writeFileStringAtomically({
      filePath: activationPath(input),
      contents: `${JSON.stringify(next, null, 2)}\n`,
    });
    yield* pruneManagedProviderVersionDirectories({
      stateDir: input.stateDir,
      provider: input.provider,
      retainedVersions: new Set([next.active.version]),
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("could not prune rejected managed provider runtime", {
          provider: input.provider,
          installationId: input.installationId,
          cause: cause.message,
        }),
      ),
    );
    return true;
  });
}

export function deactivateManagedProviderRuntimeInstallation(input: {
  readonly stateDir: string;
  readonly provider: ProviderKind;
  readonly installationId: string;
}) {
  return Effect.gen(function* () {
    const current = yield* readManagedProviderRuntimeActivation(input);
    if (!current || current.active.installationId !== input.installationId) return false;
    if (current.previous) {
      return yield* rollbackManagedProviderRuntime(input);
    }
    yield* Effect.tryPromise({
      try: () => rm(activationPath(input), { force: true }),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    });
    return true;
  });
}

export function resolveProviderBinary(input: {
  readonly stateDir: string;
  readonly provider: ProviderKind;
}) {
  return Effect.gen(function* () {
    const activation = yield* readManagedProviderRuntimeActivation(input);
    if (activation) {
      const managedBinaryPath = yield* resolveVersionExecutable({
        ...input,
        runtime: activation.active,
      });
      if (managedBinaryPath) {
        return {
          binaryPath: managedBinaryPath,
          ownership: "managed",
          installationId: activation.active.installationId,
          version: activation.active.version,
        } satisfies ResolvedProviderBinary;
      }
    }
    return yield* Effect.fail(
      new Error(`Provider '${input.provider}' has no valid managed runtime activation.`),
    );
  });
}
