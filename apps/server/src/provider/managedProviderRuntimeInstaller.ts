import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import type { ProviderKind } from "@penkra/contracts";
import { prepareWindowsSafeProcess } from "@penkra/shared/windowsProcess";
import { Duration, Effect, FileSystem, Option, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  activateManagedProviderRuntime,
  resolveManagedProviderVersionDirectory,
} from "./managedProviderRuntime";
import { compareSemverVersions, parseGenericCliVersion } from "./providerMaintenance";

const INSTALL_TIMEOUT = Duration.minutes(2);
const INSTALL_OUTPUT_LIMIT = 32 * 1024;

export interface ManagedProviderRuntimeInstallInput {
  readonly stateDir: string;
  readonly provider: ProviderKind;
  readonly version: string;
  readonly packageName: string;
  readonly binaryName: string;
}

export interface ManagedProviderRuntimeInstallResult {
  readonly binaryPath: string;
  readonly version: string;
  readonly reused: boolean;
}

interface ManagedProviderCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

const EXECUTABLE_PREFIX_BYTES = 4;

function executablePrefixIs(input: Uint8Array, expected: ReadonlyArray<number>): boolean {
  return expected.every((byte, index) => input[index] === byte);
}

export function isSpawnableManagedExecutablePrefix(
  prefix: Uint8Array,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === "win32") return true;
  if (executablePrefixIs(prefix, [0x23, 0x21])) return true;
  if (platform === "linux") return executablePrefixIs(prefix, [0x7f, 0x45, 0x4c, 0x46]);
  if (platform !== "darwin") return true;
  return [
    [0xfe, 0xed, 0xfa, 0xce],
    [0xce, 0xfa, 0xed, 0xfe],
    [0xfe, 0xed, 0xfa, 0xcf],
    [0xcf, 0xfa, 0xed, 0xfe],
    [0xca, 0xfe, 0xba, 0xbe],
    [0xbe, 0xba, 0xfe, 0xca],
    [0xca, 0xfe, 0xba, 0xbf],
    [0xbf, 0xba, 0xfe, 0xca],
  ].some((magic) => executablePrefixIs(prefix, magic));
}

function validateManagedExecutable(executablePath: string) {
  if (process.platform === "win32") return Effect.void;
  return Effect.tryPromise({
    try: async () => {
      const file = await open(executablePath, "r");
      try {
        const prefix = new Uint8Array(EXECUTABLE_PREFIX_BYTES);
        const { bytesRead } = await file.read(prefix, 0, prefix.length, 0);
        if (!isSpawnableManagedExecutablePrefix(prefix.subarray(0, bytesRead))) {
          throw new Error(
            "Managed provider package did not install a directly executable binary or shebang script.",
          );
        }
      } finally {
        await file.close();
      }
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });
}

export type ManagedProviderCommandRunner = (input: {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
}) => Effect.Effect<
  ManagedProviderCommandResult,
  Error,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
>;

function collectOutput(stream: Stream.Stream<Uint8Array, unknown>): Effect.Effect<string, unknown> {
  return Stream.runFold(
    stream,
    () => "",
    (output, chunk) => `${output}${new TextDecoder().decode(chunk)}`.slice(-INSTALL_OUTPUT_LIMIT),
  );
}

function runCommand(input: { readonly executable: string; readonly args: ReadonlyArray<string> }) {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const prepared = prepareWindowsSafeProcess(input.executable, input.args, {
      env: process.env,
    });
    const child = yield* spawner.spawn(
      ChildProcess.make(prepared.command, prepared.args, {
        shell: prepared.shell,
        ...(prepared.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        env: process.env,
        stdin: "ignore",
      }),
    );
    yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectOutput(child.stdout),
        collectOutput(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );
    return { stdout, stderr, exitCode };
  }).pipe(
    Effect.scoped,
    Effect.mapError((cause) => (cause instanceof Error ? cause : new Error(String(cause)))),
  );
}

function describeCommandFailure(input: {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}) {
  const detail = [input.stderr, input.stdout]
    .map((value) => value.trim())
    .filter(Boolean)
    .join("\n")
    .slice(-INSTALL_OUTPUT_LIMIT);
  return detail
    ? `Command exited with code ${input.exitCode}: ${detail}`
    : `Command exited with code ${input.exitCode}.`;
}

function validateInstalledVersion(
  expectedVersion: string,
  probe: ManagedProviderCommandResult,
): Error | null {
  if (probe.exitCode !== 0) {
    return new Error(describeCommandFailure(probe));
  }
  const reportedVersion = parseGenericCliVersion(
    [probe.stdout, probe.stderr].filter(Boolean).join("\n"),
  );
  if (!reportedVersion || compareSemverVersions(reportedVersion, expectedVersion) !== 0) {
    return new Error(
      `Expected provider version ${expectedVersion}, but its CLI reported ${
        reportedVersion ?? "no parseable version"
      }.`,
    );
  }
  return null;
}

function executablePathForVersion(input: {
  readonly versionDirectory: string;
  readonly binaryName: string;
  readonly path: Path.Path;
}) {
  const extension = process.platform === "win32" ? ".cmd" : "";
  return input.path.join(
    input.versionDirectory,
    "node_modules",
    ".bin",
    `${input.binaryName}${extension}`,
  );
}

/**
 * Installs an exact registry version into an isolated staging directory,
 * verifies its CLI entry point, then atomically makes the completed directory
 * visible and switches the activation record. Lifecycle scripts are disabled;
 * providers that require them fail closed and retain the previous runtime.
 */
export function installManagedProviderRuntime(
  input: ManagedProviderRuntimeInstallInput,
  options?: { readonly runCommand?: ManagedProviderCommandRunner },
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const finalDirectory = resolveManagedProviderVersionDirectory(input);
    const finalExecutable = executablePathForVersion({
      versionDirectory: finalDirectory,
      binaryName: input.binaryName,
      path,
    });

    if (yield* fs.exists(finalExecutable)) {
      yield* validateManagedExecutable(finalExecutable);
      const probe = yield* (options?.runCommand ?? runCommand)({
        executable: finalExecutable,
        args: ["--version"],
      });
      const validationError = validateInstalledVersion(input.version, probe);
      if (validationError) {
        return yield* Effect.fail(
          new Error(`Retained managed runtime is invalid. ${validationError.message}`),
        );
      }
      yield* activateManagedProviderRuntime({
        ...input,
        executablePath: finalExecutable,
      });
      return {
        binaryPath: finalExecutable,
        version: input.version,
        reused: true,
      } satisfies ManagedProviderRuntimeInstallResult;
    }

    const stagingDirectory = `${finalDirectory}.staging-${randomUUID()}`;
    yield* fs.makeDirectory(stagingDirectory, { recursive: true });
    const cleanupStaging = fs
      .remove(stagingDirectory, { recursive: true, force: true })
      .pipe(Effect.ignore);

    return yield* Effect.gen(function* () {
      const install = yield* (options?.runCommand ?? runCommand)({
        executable: "npm",
        args: [
          "install",
          "--prefix",
          stagingDirectory,
          "--no-save",
          "--package-lock=false",
          "--ignore-scripts",
          "--audit=false",
          "--fund=false",
          "--loglevel=error",
          `${input.packageName}@${input.version}`,
        ],
      });
      if (install.exitCode !== 0) {
        return yield* Effect.fail(
          new Error(`Managed runtime install failed. ${describeCommandFailure(install)}`),
        );
      }

      const stagingExecutable = executablePathForVersion({
        versionDirectory: stagingDirectory,
        binaryName: input.binaryName,
        path,
      });
      if (!(yield* fs.exists(stagingExecutable))) {
        return yield* Effect.fail(
          new Error(
            `Managed runtime package did not install the '${input.binaryName}' executable.`,
          ),
        );
      }
      yield* validateManagedExecutable(stagingExecutable);
      const probe = yield* (options?.runCommand ?? runCommand)({
        executable: stagingExecutable,
        args: ["--version"],
      });
      const validationError = validateInstalledVersion(input.version, probe);
      if (validationError) {
        return yield* Effect.fail(
          new Error(`Managed runtime validation failed. ${validationError.message}`),
        );
      }

      yield* fs.makeDirectory(path.dirname(finalDirectory), {
        recursive: true,
      });
      yield* fs.rename(stagingDirectory, finalDirectory);
      yield* activateManagedProviderRuntime({
        ...input,
        executablePath: finalExecutable,
      });
      return {
        binaryPath: finalExecutable,
        version: input.version,
        reused: false,
      } satisfies ManagedProviderRuntimeInstallResult;
    }).pipe(
      Effect.timeoutOption(INSTALL_TIMEOUT),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new Error("Managed provider runtime installation timed out after 2 minutes."),
            ),
          onSome: Effect.succeed,
        }),
      ),
      Effect.ensuring(cleanupStaging),
    );
  });
}
