import {
  DEFAULT_SERVER_SETTINGS,
  type ProviderKind,
  type ProviderStartOptions,
} from "@synara/contracts";
import { Effect, FileSystem, Path } from "effect";

import { writeFileStringAtomically } from "../atomicWrite";

const MANAGED_PROVIDER_RUNTIME_SCHEMA_VERSION = 1;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface ManagedProviderRuntimeVersion {
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
  readonly ownership: "external" | "managed";
  readonly version: string | null;
}

export function isCanonicalProviderBinaryPath(
  provider: ProviderKind,
  configuredBinaryPath: string,
): boolean {
  return (
    configuredBinaryPath.trim() === DEFAULT_SERVER_SETTINGS.providers[provider].binaryPath.trim()
  );
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
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const versionDirectory = path.resolve(
      resolveManagedProviderVersionDirectory({
        stateDir: input.stateDir,
        provider: input.provider,
        version: input.runtime.version,
      }),
    );
    const executablePath = path.resolve(versionDirectory, input.runtime.executableRelativePath);
    const [realVersionDirectory, realExecutablePath] = yield* Effect.all([
      fs.realPath(versionDirectory).pipe(Effect.catch(() => Effect.succeed(null))),
      fs.realPath(executablePath).pipe(Effect.catch(() => Effect.succeed(null))),
    ]);
    if (!realVersionDirectory || !realExecutablePath) return null;
    const relative = path.relative(realVersionDirectory, realExecutablePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
    return executablePath;
  });
}

export function readManagedProviderRuntimeActivation(input: {
  readonly stateDir: string;
  readonly provider: ProviderKind;
}) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs
      .readFileString(activationPath(input))
      .pipe(Effect.catch(() => Effect.succeed(null)));
    return raw === null ? null : parseActivation(input.provider, raw);
  });
}

export function activateManagedProviderRuntime(input: {
  readonly stateDir: string;
  readonly provider: ProviderKind;
  readonly version: string;
  readonly executablePath: string;
  readonly activatedAt?: string;
}) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
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
    if (!(yield* fs.exists(executablePath))) {
      return yield* Effect.fail(
        new Error(`Managed provider executable does not exist: ${executablePath}`),
      );
    }
    const [realVersionDirectory, realExecutablePath] = yield* Effect.all([
      fs.realPath(versionDirectory),
      fs.realPath(executablePath),
    ]);
    const realRelative = path.relative(realVersionDirectory, realExecutablePath);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      return yield* Effect.fail(
        new Error("Managed provider executable symlink must remain inside its version directory."),
      );
    }

    const current = yield* readManagedProviderRuntimeActivation(input);
    const active: ManagedProviderRuntimeVersion = {
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

export function resolveProviderBinary(input: {
  readonly stateDir: string;
  readonly provider: ProviderKind;
  readonly configuredBinaryPath: string;
}) {
  return Effect.gen(function* () {
    const configuredBinaryPath = input.configuredBinaryPath.trim();
    if (!isCanonicalProviderBinaryPath(input.provider, configuredBinaryPath)) {
      return {
        binaryPath: configuredBinaryPath,
        ownership: "external",
        version: null,
      } satisfies ResolvedProviderBinary;
    }

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
          version: activation.active.version,
        } satisfies ResolvedProviderBinary;
      }
    }

    return {
      binaryPath: configuredBinaryPath,
      ownership: "external",
      version: null,
    } satisfies ResolvedProviderBinary;
  });
}

export function resolveManagedProviderStartOptions(input: {
  readonly stateDir: string;
  readonly provider: ProviderKind;
  readonly configuredBinaryPath: string;
  readonly providerOptions: ProviderStartOptions;
}) {
  return Effect.gen(function* () {
    const resolution = yield* resolveProviderBinary(input);
    if (resolution.ownership !== "managed") return input.providerOptions;
    return {
      ...input.providerOptions,
      [input.provider]: {
        ...input.providerOptions[input.provider],
        binaryPath: resolution.binaryPath,
      },
    } as ProviderStartOptions;
  });
}
