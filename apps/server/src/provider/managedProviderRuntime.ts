import type { ProviderKind } from "@penkra/contracts";
import { readFile, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";

import { writeFileStringAtomically } from "../atomicWrite";

const MANAGED_PROVIDER_RUNTIME_SCHEMA_VERSION = 1;
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
    const parsed = JSON.parse(raw) as Partial<ManagedProviderRuntimeActivation>;
    if (
      parsed.schemaVersion !== MANAGED_PROVIDER_RUNTIME_SCHEMA_VERSION ||
      parsed.provider !== provider ||
      !isRuntimeVersion(parsed.active) ||
      (parsed.previous !== null && !isRuntimeVersion(parsed.previous))
    ) {
      return null;
    }
    return parsed as ManagedProviderRuntimeActivation;
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
    const next: ManagedProviderRuntimeActivation = {
      schemaVersion: MANAGED_PROVIDER_RUNTIME_SCHEMA_VERSION,
      provider: input.provider,
      active,
      previous: current?.active ?? null,
    };
    yield* writeFileStringAtomically({
      filePath: activationPath(input),
      contents: `${JSON.stringify(next, null, 2)}\n`,
    });
    return next;
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
    };
    yield* writeFileStringAtomically({
      filePath: activationPath(input),
      contents: `${JSON.stringify(next, null, 2)}\n`,
    });
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
