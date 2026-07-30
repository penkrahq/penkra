import { randomUUID } from "node:crypto";
import type { ProviderKind } from "@synara/contracts";
import { prepareWindowsSafeProcess } from "@synara/shared/windowsProcess";
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
