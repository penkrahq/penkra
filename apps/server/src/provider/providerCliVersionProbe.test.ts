import { Effect } from "effect";
import { systemError } from "effect/PlatformError";
import { describe, expect, it } from "vitest";

import { probeProviderCliVersion } from "./providerCliVersionProbe";

const success = { stdout: "1.2.3", stderr: "", code: 0 } as const;

describe("probeProviderCliVersion", () => {
  it("classifies successful and nonzero command results", async () => {
    await expect(
      Effect.runPromise(probeProviderCliVersion(Effect.succeed(success), 100)),
    ).resolves.toEqual({ outcome: "success", result: success });

    const nonzero = { stdout: "", stderr: "failed", code: 2 } as const;
    await expect(
      Effect.runPromise(probeProviderCliVersion(Effect.succeed(nonzero), 100)),
    ).resolves.toEqual({ outcome: "nonzero", result: nonzero });
  });

  it("distinguishes missing commands from other execution failures", async () => {
    const missing = Object.assign(new Error("spawn failed"), { code: "ENOENT" });
    await expect(
      Effect.runPromise(probeProviderCliVersion(Effect.fail(missing), 100)),
    ).resolves.toEqual({ outcome: "missing", cause: missing });

    const failure = new Error("permission denied");
    await expect(
      Effect.runPromise(probeProviderCliVersion(Effect.fail(failure), 100)),
    ).resolves.toEqual({ outcome: "failure", cause: failure });
  });

  it("uses the platform error reason, not diagnostic wording", async () => {
    const missing = systemError({
      _tag: "NotFound",
      module: "ChildProcessSpawner",
      method: "spawn",
    });
    const denied = systemError({
      _tag: "PermissionDenied",
      module: "ChildProcessSpawner",
      method: "spawn",
      description: "ENOENT from a nested tool",
    });
    for (const [cause, outcome] of [
      [missing, "missing"],
      [denied, "failure"],
      [new Error("remote tool reported ENOENT or NotFound"), "failure"],
    ] as const) {
      await expect(
        Effect.runPromise(probeProviderCliVersion(Effect.fail(cause), 100)),
      ).resolves.toEqual({ outcome, cause });
    }
  });

  it("classifies timeouts", async () => {
    await expect(Effect.runPromise(probeProviderCliVersion(Effect.never, 1))).resolves.toEqual({
      outcome: "timeout",
    });
  });
});
