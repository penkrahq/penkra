import { Deferred, Effect, Exit, Scope } from "effect";
import { describe, expect, it } from "vitest";

import {
  evaluateProviderTurnIdleTick,
  forkProviderTurnIdleWatchdog,
  resolveProviderTurnIdleTimeoutMs,
} from "./ProviderTurnIdleWatchdog.ts";

describe("evaluateProviderTurnIdleTick", () => {
  it("stops once the turn is no longer active, regardless of idle state", () => {
    expect(
      evaluateProviderTurnIdleTick({
        isTurnActive: false,
        isAwaitingHuman: false,
        idleMs: 10_000_000,
        idleTimeoutMs: 1,
      }),
    ).toBe("stop");
  });

  it("refreshes the clock while the turn is legitimately blocked on a human", () => {
    expect(
      evaluateProviderTurnIdleTick({
        isTurnActive: true,
        isAwaitingHuman: true,
        idleMs: 10_000_000,
        idleTimeoutMs: 1,
      }),
    ).toBe("touch");
  });

  it("keeps watching while the turn is still within the idle budget", () => {
    expect(
      evaluateProviderTurnIdleTick({
        isTurnActive: true,
        isAwaitingHuman: false,
        idleMs: 5_000,
        idleTimeoutMs: 600_000,
      }),
    ).toBe("continue");
  });

  it("times out at or past the threshold", () => {
    expect(
      evaluateProviderTurnIdleTick({
        isTurnActive: true,
        isAwaitingHuman: false,
        idleMs: 600_000,
        idleTimeoutMs: 600_000,
      }),
    ).toBe("timeout");
    expect(
      evaluateProviderTurnIdleTick({
        isTurnActive: true,
        isAwaitingHuman: false,
        idleMs: 600_001,
        idleTimeoutMs: 600_000,
      }),
    ).toBe("timeout");
  });
});

describe("resolveProviderTurnIdleTimeoutMs", () => {
  const envVar = "PENKRA_TEST_TURN_IDLE_TIMEOUT_MS";
  const defaultMs = 600_000;

  it("falls back to the default when unset, blank, or non-numeric", () => {
    expect(resolveProviderTurnIdleTimeoutMs({ envVar, defaultMs, env: {} })).toBe(defaultMs);
    expect(resolveProviderTurnIdleTimeoutMs({ envVar, defaultMs, env: { [envVar]: "   " } })).toBe(
      defaultMs,
    );
    expect(resolveProviderTurnIdleTimeoutMs({ envVar, defaultMs, env: { [envVar]: "soon" } })).toBe(
      defaultMs,
    );
  });

  it("rejects non-positive overrides so a typo cannot disable the backstop", () => {
    expect(resolveProviderTurnIdleTimeoutMs({ envVar, defaultMs, env: { [envVar]: "0" } })).toBe(
      defaultMs,
    );
    expect(
      resolveProviderTurnIdleTimeoutMs({ envVar, defaultMs, env: { [envVar]: "-5000" } }),
    ).toBe(defaultMs);
  });

  it("accepts a positive numeric override (trimmed)", () => {
    expect(
      resolveProviderTurnIdleTimeoutMs({ envVar, defaultMs, env: { [envVar]: "30000" } }),
    ).toBe(30_000);
    expect(
      resolveProviderTurnIdleTimeoutMs({ envVar, defaultMs, env: { [envVar]: "  45000  " } }),
    ).toBe(45_000);
  });
});

describe("forkProviderTurnIdleWatchdog", () => {
  it("force-fails a turn that has been idle past the threshold", async () => {
    const program = Effect.gen(function* () {
      const scope = yield* Scope.make();
      const fired = yield* Deferred.make<number>();
      let active = true;

      yield* forkProviderTurnIdleWatchdog({
        idleTimeoutMs: 1,
        checkIntervalMs: 1,
        scope,
        isTurnActive: () => active,
        isAwaitingHuman: () => false,
        // Epoch baseline → the turn reads as effectively infinitely idle.
        lastActivityAt: () => 0,
        touchActivity: () => {},
        onIdleTimeout: (idleMs) =>
          Effect.gen(function* () {
            active = false;
            yield* Deferred.succeed(fired, idleMs);
          }),
      });

      const idleMs = yield* Deferred.await(fired);
      yield* Scope.close(scope, Exit.void);
      return idleMs;
    });

    const idleMs = await Effect.runPromise(program);
    expect(idleMs).toBeGreaterThan(0);
  });

  it("does not fire while the turn keeps reporting fresh activity", async () => {
    const program = Effect.gen(function* () {
      const scope = yield* Scope.make();
      let fired = false;

      yield* forkProviderTurnIdleWatchdog({
        idleTimeoutMs: 60_000,
        checkIntervalMs: 1,
        scope,
        isTurnActive: () => true,
        isAwaitingHuman: () => false,
        // Always "just now" → never crosses the 60s threshold.
        lastActivityAt: () => Date.now(),
        touchActivity: () => {},
        onIdleTimeout: () =>
          Effect.sync(() => {
            fired = true;
          }),
      });

      yield* Effect.sleep(25);
      yield* Scope.close(scope, Exit.void);
      return fired;
    });

    const fired = await Effect.runPromise(program);
    expect(fired).toBe(false);
  });

  it("uses the live timeout override for provider work hidden from the parent stream", async () => {
    const program = Effect.gen(function* () {
      const scope = yield* Scope.make();
      let fired = false;
      let nestedWorkActive = true;

      yield* forkProviderTurnIdleWatchdog({
        idleTimeoutMs: 1,
        currentIdleTimeoutMs: () => (nestedWorkActive ? 60_000 : 1),
        checkIntervalMs: 1,
        scope,
        isTurnActive: () => true,
        isAwaitingHuman: () => false,
        lastActivityAt: () => Date.now() - 100,
        touchActivity: () => {},
        onIdleTimeout: () =>
          Effect.sync(() => {
            fired = true;
          }),
      });

      yield* Effect.sleep(10);
      const stayedAliveDuringNestedWork = !fired;
      nestedWorkActive = false;
      yield* Effect.sleep(10);
      yield* Scope.close(scope, Exit.void);
      return { fired, stayedAliveDuringNestedWork };
    });

    await expect(Effect.runPromise(program)).resolves.toEqual({
      fired: true,
      stayedAliveDuringNestedWork: true,
    });
  });
});
