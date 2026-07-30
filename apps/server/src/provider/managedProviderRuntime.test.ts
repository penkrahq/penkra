import * as NodeServices from "@effect/platform-node/NodeServices";
import fs from "node:fs";
import { Effect, FileSystem, Path } from "effect";
import { describe, expect, it } from "vitest";

import {
  activateManagedProviderRuntime,
  readManagedProviderRuntimeActivation,
  resolveManagedProviderStartOptions,
  resolveManagedProviderVersionDirectory,
  resolveProviderBinary,
  rollbackManagedProviderRuntime,
} from "./managedProviderRuntime";

function runInTemp<A>(
  effect: (stateDir: string) => Effect.Effect<A, unknown, FileSystem.FileSystem | Path.Path>,
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const stateDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "penkra-provider-runtime-",
      });
      return yield* effect(stateDir);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

function createVersionExecutable(stateDir: string, version: string) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const versionDirectory = resolveManagedProviderVersionDirectory({
      stateDir,
      provider: "codex",
      version,
    });
    const executablePath = path.join(versionDirectory, "bin", "codex");
    yield* fileSystem.makeDirectory(path.dirname(executablePath), {
      recursive: true,
    });
    yield* fileSystem.writeFileString(executablePath, "#!/bin/sh\n");
    return executablePath;
  });
}

describe("managed provider runtime", () => {
  it("uses an activated managed runtime for the canonical provider command", async () => {
    const result = await runInTemp((stateDir) =>
      Effect.gen(function* () {
        const executablePath = yield* createVersionExecutable(stateDir, "1.2.3");
        yield* activateManagedProviderRuntime({
          stateDir,
          provider: "codex",
          version: "1.2.3",
          executablePath,
          activatedAt: "2026-07-30T00:00:00.000Z",
        });
        return yield* resolveProviderBinary({
          stateDir,
          provider: "codex",
          configuredBinaryPath: "codex",
        });
      }),
    );

    expect(result).toMatchObject({
      ownership: "managed",
      version: "1.2.3",
    });
    expect(result.binaryPath).toContain("/versions/1.2.3/bin/codex");
  });

  it("never overrides a custom provider binary", async () => {
    const result = await runInTemp((stateDir) =>
      Effect.gen(function* () {
        const executablePath = yield* createVersionExecutable(stateDir, "1.2.3");
        yield* activateManagedProviderRuntime({
          stateDir,
          provider: "codex",
          version: "1.2.3",
          executablePath,
        });
        return yield* resolveProviderBinary({
          stateDir,
          provider: "codex",
          configuredBinaryPath: "/custom/bin/codex",
        });
      }),
    );

    expect(result).toEqual({
      binaryPath: "/custom/bin/codex",
      ownership: "external",
      version: null,
    });
  });

  it("falls back safely when the activation record or executable is invalid", async () => {
    const result = await runInTemp((stateDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const runtimeRoot = path.join(stateDir, "provider-runtimes", "codex");
        yield* fileSystem.makeDirectory(runtimeRoot, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(runtimeRoot, "activation.json"),
          JSON.stringify({
            schemaVersion: 1,
            provider: "codex",
            active: {
              version: "1.2.3",
              executableRelativePath: "../../outside",
              activatedAt: "2026-07-30T00:00:00.000Z",
            },
            previous: null,
          }),
        );
        return yield* resolveProviderBinary({
          stateDir,
          provider: "codex",
          configuredBinaryPath: "codex",
        });
      }),
    );

    expect(result).toEqual({
      binaryPath: "codex",
      ownership: "external",
      version: null,
    });
  });

  it("atomically switches and rolls back between retained versions", async () => {
    const result = await runInTemp((stateDir) =>
      Effect.gen(function* () {
        const first = yield* createVersionExecutable(stateDir, "1.0.0");
        const second = yield* createVersionExecutable(stateDir, "2.0.0");
        yield* activateManagedProviderRuntime({
          stateDir,
          provider: "codex",
          version: "1.0.0",
          executablePath: first,
        });
        yield* activateManagedProviderRuntime({
          stateDir,
          provider: "codex",
          version: "2.0.0",
          executablePath: second,
        });
        const rolledBack = yield* rollbackManagedProviderRuntime({
          stateDir,
          provider: "codex",
        });
        const activation = yield* readManagedProviderRuntimeActivation({
          stateDir,
          provider: "codex",
        });
        return { rolledBack, activation };
      }),
    );

    expect(result.rolledBack).toBe(true);
    expect(result.activation?.active.version).toBe("1.0.0");
    expect(result.activation?.previous?.version).toBe("2.0.0");
  });

  it("rejects an executable symlink that escapes the managed version", async () => {
    await expect(
      runInTemp((stateDir) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const versionDirectory = resolveManagedProviderVersionDirectory({
            stateDir,
            provider: "codex",
            version: "1.2.3",
          });
          const executablePath = path.join(versionDirectory, "bin", "codex");
          const outsidePath = path.join(stateDir, "outside-codex");
          yield* fileSystem.makeDirectory(path.dirname(executablePath), {
            recursive: true,
          });
          yield* fileSystem.writeFileString(outsidePath, "#!/bin/sh\n");
          yield* fileSystem.symlink(outsidePath, executablePath);
          yield* activateManagedProviderRuntime({
            stateDir,
            provider: "codex",
            version: "1.2.3",
            executablePath,
          });
        }),
      ),
    ).rejects.toThrow("symlink must remain inside");
  });

  it("pins the resolved binary into only the selected provider options", async () => {
    const result = await runInTemp((stateDir) =>
      Effect.gen(function* () {
        const executablePath = yield* createVersionExecutable(stateDir, "1.2.3");
        yield* activateManagedProviderRuntime({
          stateDir,
          provider: "codex",
          version: "1.2.3",
          executablePath,
        });
        return yield* resolveManagedProviderStartOptions({
          stateDir,
          provider: "codex",
          configuredBinaryPath: "codex",
          providerOptions: {
            codex: { binaryPath: "codex", homePath: "/codex-home" },
            claudeAgent: { binaryPath: "claude" },
          },
        });
      }),
    );

    expect(result.codex?.binaryPath).toContain("/versions/1.2.3/bin/codex");
    expect(result.codex?.homePath).toBe("/codex-home");
    expect(result.claudeAgent?.binaryPath).toBe("claude");
  });

  it("writes the activation record as a private file", async () => {
    const mode = await runInTemp((stateDir) =>
      Effect.gen(function* () {
        const executablePath = yield* createVersionExecutable(stateDir, "1.2.3");
        yield* activateManagedProviderRuntime({
          stateDir,
          provider: "codex",
          version: "1.2.3",
          executablePath,
        });
        return fs.statSync(`${stateDir}/provider-runtimes/codex/activation.json`).mode & 0o777;
      }),
    );
    if (process.platform !== "win32") expect(mode).toBe(0o600);
  });
});
