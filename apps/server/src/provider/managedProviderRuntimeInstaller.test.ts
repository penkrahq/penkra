import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, it, vi } from "vitest";

import { resolveProviderBinary } from "./managedProviderRuntime";
import {
  installManagedProviderRuntime,
  type ManagedProviderCommandRunner,
} from "./managedProviderRuntimeInstaller";

function runInTemp<A>(
  effect: (
    stateDir: string,
  ) => Effect.Effect<
    A,
    unknown,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >,
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const stateDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "penkra-provider-installer-",
      });
      return yield* effect(stateDir);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

function successfulRunner(): ManagedProviderCommandRunner {
  let version = "0.0.0";
  return vi.fn((command) =>
    Effect.gen(function* () {
      if (command.executable === "npm") {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const prefixIndex = command.args.indexOf("--prefix");
        const prefix = command.args[prefixIndex + 1];
        if (!prefix) return { stdout: "", stderr: "missing prefix", exitCode: 1 };
        version = command.args.at(-1)?.split("@").at(-1) ?? "0.0.0";
        const executablePath = path.join(prefix, "node_modules", ".bin", "codex");
        yield* fileSystem.makeDirectory(path.dirname(executablePath), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(executablePath, "#!/bin/sh\n");
      }
      return { stdout: `codex ${version}`, stderr: "", exitCode: 0 };
    }),
  );
}

describe("managed provider runtime installer", () => {
  it("stages, validates, retains, and activates an exact package version", async () => {
    const runner = successfulRunner();
    const result = await runInTemp((stateDir) =>
      Effect.gen(function* () {
        const installed = yield* installManagedProviderRuntime(
          {
            stateDir,
            provider: "codex",
            version: "1.2.3",
            packageName: "@openai/codex",
            binaryName: "codex",
          },
          { runCommand: runner },
        );
        const resolved = yield* resolveProviderBinary({
          stateDir,
          provider: "codex",
          configuredBinaryPath: "codex",
        });
        return { installed, resolved };
      }),
    );

    expect(result.installed).toMatchObject({
      version: "1.2.3",
      reused: false,
    });
    expect(result.resolved).toMatchObject({
      ownership: "managed",
      version: "1.2.3",
    });
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        executable: "npm",
        args: expect.arrayContaining(["--ignore-scripts", "@openai/codex@1.2.3"]),
      }),
    );
  });

  it("leaves the prior activation intact when the next install fails", async () => {
    const result = await runInTemp((stateDir) =>
      Effect.gen(function* () {
        yield* installManagedProviderRuntime(
          {
            stateDir,
            provider: "codex",
            version: "1.0.0",
            packageName: "@openai/codex",
            binaryName: "codex",
          },
          { runCommand: successfulRunner() },
        );
        const failed = yield* installManagedProviderRuntime(
          {
            stateDir,
            provider: "codex",
            version: "2.0.0",
            packageName: "@openai/codex",
            binaryName: "codex",
          },
          {
            runCommand: () =>
              Effect.succeed({
                stdout: "",
                stderr: "registry unavailable",
                exitCode: 1,
              }),
          },
        ).pipe(Effect.result);
        const resolved = yield* resolveProviderBinary({
          stateDir,
          provider: "codex",
          configuredBinaryPath: "codex",
        });
        return { failed, resolved };
      }),
    );

    expect(result.failed._tag).toBe("Failure");
    expect(result.resolved.version).toBe("1.0.0");
    expect(result.resolved.binaryPath).toContain("/versions/1.0.0/");
  });
});
