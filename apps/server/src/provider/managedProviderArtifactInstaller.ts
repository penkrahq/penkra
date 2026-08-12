// FILE: managedProviderArtifactInstaller.ts
// Purpose: Stages and verifies official provider artifacts before atomic activation.

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { prepareWindowsSafeProcess } from "@penkra/shared/windowsProcess";
import { Duration, Effect, FileSystem, Option, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { writeFileStringAtomically } from "../atomicWrite";
import type { ManagedProviderArtifact } from "./managedProviderArtifact";
import {
  activateManagedProviderRuntime,
  resolveManagedProviderVersionDirectory,
} from "./managedProviderRuntime";
import { compareSemverVersions, parseGenericCliVersion } from "./providerVersion";

const INSTALL_TIMEOUT = Duration.minutes(5);
const COMMAND_OUTPUT_LIMIT = 64 * 1024;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const GENERATION_MANIFEST_SCHEMA_VERSION = 1;

export interface ManagedProviderGenerationManifest {
  readonly schemaVersion: typeof GENERATION_MANIFEST_SCHEMA_VERSION;
  readonly provider: ManagedProviderArtifact["provider"];
  readonly installationId: string;
  readonly version: string;
  readonly platform: NodeJS.Platform;
  readonly architecture: NodeJS.Architecture;
  readonly adapterVersion: string;
  readonly protocolVersion: string;
  readonly executableRelativePath: string;
  readonly installedAt: string;
  readonly artifact: {
    readonly source: ManagedProviderArtifact["source"];
    readonly metadataUrl: string;
    readonly url: string;
    readonly assetName: string;
    readonly sha256: string;
    readonly integrity: "verified";
  };
}

export interface ManagedProviderArtifactInstallInput {
  readonly stateDir: string;
  readonly artifact: ManagedProviderArtifact;
  readonly adapterVersion: string;
  readonly protocolVersion: string;
  readonly installedAt?: string;
}

export interface ManagedProviderArtifactInstallResult {
  readonly binaryPath: string;
  readonly installationId: string;
  readonly version: string;
  readonly reused: boolean;
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export type ManagedProviderArtifactCommandRunner = (input: {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
}) => Effect.Effect<
  CommandResult,
  Error,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
>;

export type ManagedProviderArtifactDownloader = (input: {
  readonly url: string;
  readonly destination: string;
}) => Effect.Effect<void, Error>;

function collectOutput(stream: Stream.Stream<Uint8Array, unknown>): Effect.Effect<string, unknown> {
  return Stream.runFold(
    stream,
    () => "",
    (output, chunk) => `${output}${new TextDecoder().decode(chunk)}`.slice(-COMMAND_OUTPUT_LIMIT),
  );
}

function runCommand(input: { readonly executable: string; readonly args: ReadonlyArray<string> }) {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const prepared = prepareWindowsSafeProcess(input.executable, input.args, { env: process.env });
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

function downloadArtifact(input: { readonly url: string; readonly destination: string }) {
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(input.url, { redirect: "follow" });
      if (!response.ok || !response.body) {
        throw new Error(`Artifact download failed with HTTP ${response.status}.`);
      }
      const declaredLength = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(declaredLength) && declaredLength > MAX_ARTIFACT_BYTES) {
        throw new Error("Provider artifact exceeds the 512 MiB download limit.");
      }
      let received = 0;
      const source = Readable.fromWeb(response.body as never);
      source.on("data", (chunk: Buffer) => {
        received += chunk.byteLength;
        if (received > MAX_ARTIFACT_BYTES) {
          source.destroy(new Error("Provider artifact exceeds the 512 MiB download limit."));
        }
      });
      await pipeline(source, createWriteStream(input.destination, { flags: "wx", mode: 0o600 }));
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });
}

function sha256File(filePath: string) {
  return Effect.tryPromise({
    try: async () => {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(filePath)) hash.update(chunk);
      return hash.digest("hex");
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });
}

export function validateManagedArchiveEntries(entries: string): ReadonlyArray<string> {
  const normalized = entries
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (normalized.length === 0) throw new Error("Provider artifact archive is empty.");
  for (const entry of normalized) {
    const portable = entry.replaceAll("\\", "/");
    const segments = portable.split("/").filter(Boolean);
    if (portable.startsWith("/") || /^[A-Za-z]:\//.test(portable) || segments.includes("..")) {
      throw new Error(`Provider artifact contains unsafe archive path '${entry}'.`);
    }
  }
  return normalized;
}

function describeFailure(result: CommandResult): string {
  const detail = [result.stderr, result.stdout]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n")
    .slice(-COMMAND_OUTPUT_LIMIT);
  return detail
    ? `Command exited with code ${result.exitCode}: ${detail}`
    : `Command exited with code ${result.exitCode}.`;
}

function extractArchive(input: {
  readonly archivePath: string;
  readonly stagingDirectory: string;
  readonly run: ManagedProviderArtifactCommandRunner;
}) {
  return Effect.gen(function* () {
    const listed = yield* input.run({ executable: "tar", args: ["-tf", input.archivePath] });
    if (listed.exitCode !== 0) {
      return yield* Effect.fail(
        new Error(`Could not inspect provider artifact. ${describeFailure(listed)}`),
      );
    }
    validateManagedArchiveEntries(listed.stdout);
    const extracted = yield* input.run({
      executable: "tar",
      args: ["-xf", input.archivePath, "-C", input.stagingDirectory],
    });
    if (extracted.exitCode !== 0) {
      return yield* Effect.fail(
        new Error(`Could not extract provider artifact. ${describeFailure(extracted)}`),
      );
    }
  });
}

function validateInstalledVersion(expectedVersion: string, result: CommandResult): Error | null {
  if (result.exitCode !== 0) return new Error(describeFailure(result));
  const reported = parseGenericCliVersion([result.stdout, result.stderr].join("\n"));
  if (!reported || compareSemverVersions(reported, expectedVersion) !== 0) {
    return new Error(
      `Expected provider version ${expectedVersion}, but its executable reported ${reported ?? "no parseable version"}.`,
    );
  }
  return null;
}

function generationManifest(
  input: ManagedProviderArtifactInstallInput,
  installationId: string,
): ManagedProviderGenerationManifest {
  return {
    schemaVersion: GENERATION_MANIFEST_SCHEMA_VERSION,
    provider: input.artifact.provider,
    installationId,
    version: input.artifact.version,
    platform: input.artifact.platform,
    architecture: input.artifact.architecture,
    adapterVersion: input.adapterVersion,
    protocolVersion: input.protocolVersion,
    executableRelativePath: input.artifact.executableRelativePath,
    installedAt: input.installedAt ?? new Date().toISOString(),
    artifact: {
      source: input.artifact.source,
      metadataUrl: input.artifact.metadataUrl,
      url: input.artifact.url,
      assetName: input.artifact.assetName,
      sha256: input.artifact.sha256,
      integrity: "verified",
    },
  };
}

function isGenerationManifest(value: unknown): value is ManagedProviderGenerationManifest {
  if (typeof value !== "object" || value === null) return false;
  const parsed = value as Partial<ManagedProviderGenerationManifest>;
  return (
    parsed.schemaVersion === GENERATION_MANIFEST_SCHEMA_VERSION &&
    typeof parsed.provider === "string" &&
    typeof parsed.installationId === "string" &&
    parsed.installationId.length > 0 &&
    typeof parsed.version === "string" &&
    typeof parsed.platform === "string" &&
    typeof parsed.architecture === "string" &&
    typeof parsed.adapterVersion === "string" &&
    typeof parsed.protocolVersion === "string" &&
    typeof parsed.executableRelativePath === "string" &&
    typeof parsed.installedAt === "string" &&
    typeof parsed.artifact === "object" &&
    parsed.artifact !== null &&
    typeof parsed.artifact.url === "string" &&
    typeof parsed.artifact.source === "string" &&
    typeof parsed.artifact.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(parsed.artifact.sha256) &&
    parsed.artifact.integrity === "verified"
  );
}

export function readManagedProviderGenerationManifest(input: {
  readonly stateDir: string;
  readonly provider: ManagedProviderArtifact["provider"];
  readonly version: string;
}) {
  const versionDirectory = resolveManagedProviderVersionDirectory(input);
  return Effect.tryPromise({
    try: async () => {
      try {
        const parsed = JSON.parse(
          await readFile(`${versionDirectory}/managed-runtime.json`, "utf8"),
        ) as unknown;
        return isGenerationManifest(parsed) &&
          parsed.provider === input.provider &&
          parsed.version === input.version
          ? parsed
          : null;
      } catch {
        return null;
      }
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });
}

async function readReusableManifest(
  versionDirectory: string,
  input: ManagedProviderArtifactInstallInput,
): Promise<ManagedProviderGenerationManifest | null> {
  try {
    const parsed = JSON.parse(
      await readFile(`${versionDirectory}/managed-runtime.json`, "utf8"),
    ) as unknown;
    if (
      !isGenerationManifest(parsed) ||
      parsed.provider !== input.artifact.provider ||
      parsed.version !== input.artifact.version ||
      parsed.platform !== input.artifact.platform ||
      parsed.architecture !== input.artifact.architecture ||
      parsed.adapterVersion !== input.adapterVersion ||
      parsed.protocolVersion !== input.protocolVersion ||
      parsed.executableRelativePath !== input.artifact.executableRelativePath ||
      parsed.artifact?.sha256 !== input.artifact.sha256 ||
      parsed.artifact.integrity !== "verified"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function assertFinalExecutable(input: {
  readonly versionDirectory: string;
  readonly executableRelativePath: string;
  readonly path: Path.Path;
}) {
  const directory = input.path.resolve(input.versionDirectory);
  const executable = input.path.resolve(directory, input.executableRelativePath);
  const relative = input.path.relative(directory, executable);
  if (!relative || relative.startsWith("..") || input.path.isAbsolute(relative)) {
    throw new Error("Managed provider executable path escapes its generation directory.");
  }
  return executable;
}

export function installManagedProviderArtifact(
  input: ManagedProviderArtifactInstallInput,
  options?: {
    readonly download?: ManagedProviderArtifactDownloader;
    readonly runCommand?: ManagedProviderArtifactCommandRunner;
  },
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const run = options?.runCommand ?? runCommand;
    const versionDirectory = resolveManagedProviderVersionDirectory({
      stateDir: input.stateDir,
      provider: input.artifact.provider,
      version: input.artifact.version,
    });
    const finalExecutable = assertFinalExecutable({
      versionDirectory,
      executableRelativePath: input.artifact.executableRelativePath,
      path,
    });

    if (yield* fs.exists(finalExecutable)) {
      const manifest = yield* Effect.tryPromise({
        try: () => readReusableManifest(versionDirectory, input),
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      });
      const probe = yield* run({ executable: finalExecutable, args: ["--version"] });
      const validation = validateInstalledVersion(input.artifact.version, probe);
      if (!validation && manifest) {
        yield* activateManagedProviderRuntime({
          stateDir: input.stateDir,
          provider: input.artifact.provider,
          installationId: manifest.installationId,
          version: input.artifact.version,
          executablePath: finalExecutable,
        });
        return {
          binaryPath: finalExecutable,
          installationId: manifest.installationId,
          version: input.artifact.version,
          reused: true,
        } satisfies ManagedProviderArtifactInstallResult;
      }
      // A generation is immutable. If its executable no longer matches its
      // declared version, discard the whole managed generation and reinstall
      // it from the verified official artifact.
      yield* fs.remove(versionDirectory, { recursive: true, force: true });
    } else if (yield* fs.exists(versionDirectory)) {
      yield* fs.remove(versionDirectory, { recursive: true, force: true });
    }

    const stagingDirectory = `${versionDirectory}.staging-${randomUUID()}`;
    const installationId = randomUUID();
    const archivePath = path.join(stagingDirectory, input.artifact.assetName);
    yield* Effect.tryPromise({
      try: () => mkdir(stagingDirectory, { recursive: true, mode: 0o700 }),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    });

    const cleanup = Effect.tryPromise({
      try: () => rm(stagingDirectory, { recursive: true, force: true }),
      catch: () => undefined,
    }).pipe(Effect.ignore);

    return yield* Effect.gen(function* () {
      if (path.basename(input.artifact.assetName) !== input.artifact.assetName) {
        return yield* Effect.fail(new Error("Managed provider artifact name is not a filename."));
      }
      yield* (options?.download ?? downloadArtifact)({
        url: input.artifact.url,
        destination: archivePath,
      });
      const actualDigest = yield* sha256File(archivePath);
      if (actualDigest !== input.artifact.sha256) {
        return yield* Effect.fail(
          new Error(
            `Provider artifact checksum mismatch: expected ${input.artifact.sha256}, received ${actualDigest}.`,
          ),
        );
      }

      if (input.artifact.archive === "raw") {
        const stagedExecutable = assertFinalExecutable({
          versionDirectory: stagingDirectory,
          executableRelativePath: input.artifact.executableRelativePath,
          path,
        });
        yield* Effect.tryPromise({
          try: async () => {
            await mkdir(path.dirname(stagedExecutable), { recursive: true, mode: 0o700 });
            await rename(archivePath, stagedExecutable);
          },
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        });
      } else {
        yield* extractArchive({ archivePath, stagingDirectory, run });
        yield* fs.remove(archivePath, { force: true });
      }

      const stagedExecutable = assertFinalExecutable({
        versionDirectory: stagingDirectory,
        executableRelativePath: input.artifact.executableRelativePath,
        path,
      });
      const executableStat = yield* Effect.tryPromise({
        try: () => stat(stagedExecutable),
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      });
      if (!executableStat.isFile()) {
        return yield* Effect.fail(
          new Error("Managed provider artifact did not contain its declared executable."),
        );
      }
      if (process.platform !== "win32") {
        yield* Effect.tryPromise({
          try: () => chmod(stagedExecutable, 0o700),
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        });
      }
      const probe = yield* run({ executable: stagedExecutable, args: ["--version"] });
      const validation = validateInstalledVersion(input.artifact.version, probe);
      if (validation) return yield* Effect.fail(validation);

      yield* writeFileStringAtomically({
        filePath: path.join(stagingDirectory, "managed-runtime.json"),
        contents: `${JSON.stringify(generationManifest(input, installationId), null, 2)}\n`,
      });
      yield* Effect.tryPromise({
        try: async () => {
          await mkdir(path.dirname(versionDirectory), { recursive: true, mode: 0o700 });
          await rename(stagingDirectory, versionDirectory);
        },
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      });
      yield* activateManagedProviderRuntime({
        stateDir: input.stateDir,
        provider: input.artifact.provider,
        installationId,
        version: input.artifact.version,
        executablePath: finalExecutable,
      });
      return {
        binaryPath: finalExecutable,
        installationId,
        version: input.artifact.version,
        reused: false,
      } satisfies ManagedProviderArtifactInstallResult;
    }).pipe(
      Effect.timeoutOption(INSTALL_TIMEOUT),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new Error("Managed provider artifact installation timed out after 5 minutes."),
            ),
          onSome: Effect.succeed,
        }),
      ),
      Effect.ensuring(cleanup),
    );
  });
}
