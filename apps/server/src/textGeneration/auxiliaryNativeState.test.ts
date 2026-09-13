import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";

import { TextGenerationError } from "./Errors.ts";
import { withAuxiliaryNativeState } from "./auxiliaryNativeState.ts";

const launch = {
  binaryPath: "/selected/provider",
  profileRoot: "/selected/profile",
  nativeStateRoot: "/conversation/generation",
  isolationKey: "selected-connection:generation",
  childEnvironment: () => ({
    CODEX_HOME: "/selected/profile/codex-home",
    CODEX_SQLITE_HOME: "/selected/profile/codex-sqlite-home",
    OPENCODE_DB: "/conversation/generation/opencode.db",
    XDG_CONFIG_HOME: "/selected/profile/config",
    OPENCODE_AUTH_CONTENT: "selected-credential",
  }),
};

describe("auxiliary native state ownership", () => {
  it("retains state when provider teardown cannot prove process exit", async () => {
    let root = "";
    try {
      await Effect.runPromise(
        Effect.exit(
          withAuxiliaryNativeState("opencode", launch, (auxiliary) => {
            root = auxiliary.nativeStateRoot;
            return Effect.void.pipe(Effect.ensuring(Effect.die("process teardown failed")));
          }),
        ),
      );
      expect(root).not.toBe("");
      expect(existsSync(root)).toBe(true);
    } finally {
      if (root) await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["codex", "opencode"] as const)(
    "isolates concurrent %s requests without changing credentials",
    async (provider) => {
      const roots: string[] = [];
      await Effect.runPromise(
        Effect.all(
          [0, 1].map(() =>
            withAuxiliaryNativeState(provider, launch, (auxiliary) =>
              Effect.gen(function* () {
                roots.push(auxiliary.nativeStateRoot);
                expect(existsSync(auxiliary.nativeStateRoot)).toBe(true);
                expect(auxiliary.nativeStateRoot).not.toBe(launch.nativeStateRoot);
                expect(auxiliary.profileRoot).toBe(launch.profileRoot);
                expect(auxiliary.binaryPath).toBe(launch.binaryPath);
                const env = auxiliary.childEnvironment({});
                expect(env.CODEX_HOME).toBe(launch.childEnvironment().CODEX_HOME);
                expect(env.OPENCODE_AUTH_CONTENT).toBe("selected-credential");
                expect(env.XDG_CONFIG_HOME).toBe(launch.childEnvironment().XDG_CONFIG_HOME);
                expect(provider === "opencode" ? env.OPENCODE_DB : env.CODEX_SQLITE_HOME).toContain(
                  auxiliary.nativeStateRoot,
                );
                yield* Effect.yieldNow;
              }),
            ),
          ),
          { concurrency: "unbounded" },
        ),
      );
      expect(new Set(roots).size).toBe(2);
      expect(roots.every((root) => !existsSync(root))).toBe(true);
    },
  );

  it.each(["failure", "interruption"] as const)(
    "releases state after provider finalization on %s",
    async (outcome) => {
      let root = "";
      let finalized = false;
      let signalStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      const effect = withAuxiliaryNativeState("opencode", launch, (auxiliary) =>
        Effect.gen(function* () {
          root = auxiliary.nativeStateRoot;
          signalStarted();
          return yield* (
            outcome === "failure"
              ? Effect.fail(
                  new TextGenerationError({
                    operation: "generateThreadTitle",
                    detail: "provider failed",
                  }),
                )
              : Effect.never
          ).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                expect(existsSync(root)).toBe(true);
                finalized = true;
              }),
            ),
          );
        }),
      );
      if (outcome === "failure") {
        await Effect.runPromise(Effect.exit(effect));
      } else {
        const fiber = Effect.runFork(effect);
        await started;
        await Effect.runPromise(Fiber.interrupt(fiber));
      }
      expect(finalized).toBe(true);
      expect(existsSync(root)).toBe(false);
    },
  );
});
