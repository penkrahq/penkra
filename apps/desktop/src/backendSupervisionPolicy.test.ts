import { describe, expect, it } from "vitest";

import {
  BACKEND_MAX_CONSECUTIVE_START_FAILURES,
  BACKEND_RESTART_MAX_DELAY_MS,
  BackendOutputTailDetector,
  BackendSupervisionPolicy,
  backendRestartDelayMs,
  summarizeBackendFailureOutput,
} from "./backendSupervisionPolicy";

const failure = (
  policy: BackendSupervisionPolicy,
  overrides?: {
    readonly migrationRecoveryMarkerPresent?: boolean;
    readonly quitting?: boolean;
  },
) =>
  policy.respondToStartFailure({
    quitting: overrides?.quitting ?? false,
    restartPending: false,
    migrationRecoveryMarkerPresent: overrides?.migrationRecoveryMarkerPresent ?? false,
  });

describe("backend restart supervision", () => {
  it("grows the delay across consecutive failures", () => {
    const policy = new BackendSupervisionPolicy();
    const delays: number[] = [];
    for (let index = 0; index < BACKEND_MAX_CONSECUTIVE_START_FAILURES - 1; index += 1) {
      const response = failure(policy);
      expect(response.kind).toBe("retry");
      if (response.kind === "retry") delays.push(response.delayMs);
    }
    expect(delays).toEqual([500, 1_000, 2_000, 4_000]);
    expect(backendRestartDelayMs(30)).toBe(BACKEND_RESTART_MAX_DELAY_MS);
  });

  it("resets only after backend readiness", () => {
    const policy = new BackendSupervisionPolicy();
    expect(failure(policy)).toMatchObject({ kind: "retry", delayMs: 500 });
    expect(failure(policy)).toMatchObject({ kind: "retry", delayMs: 1_000 });
    policy.recordReadiness();
    expect(failure(policy)).toMatchObject({ kind: "retry", delayMs: 500 });
  });

  it("stops respawning after the configured failure budget", () => {
    const policy = new BackendSupervisionPolicy();
    for (let index = 0; index < BACKEND_MAX_CONSECUTIVE_START_FAILURES - 1; index += 1) {
      expect(failure(policy).kind).toBe("retry");
    }
    expect(failure(policy)).toEqual({
      kind: "give-up",
      failures: BACKEND_MAX_CONSECUTIVE_START_FAILURES,
    });
  });

  it("does not consume attempts while quitting", () => {
    const policy = new BackendSupervisionPolicy();
    expect(failure(policy, { quitting: true })).toEqual({ kind: "ignore" });
    expect(policy.consecutiveFailures).toBe(0);
  });
});

describe("backend failure output", () => {
  it("bounds retained output and summarizes the last error", () => {
    const detector = new BackendOutputTailDetector();
    detector.push("starting\n");
    detector.push("DatabaseLifecycleLockedError: database in use\n    at acquire\n");
    for (let index = 0; index < 20; index += 1) detector.push("x".repeat(1_000));
    expect(detector.read().length).toBeLessThanOrEqual(8_192);
    expect(
      summarizeBackendFailureOutput(
        "starting\nDatabaseLifecycleLockedError: database in use\n    at acquire\n",
      ),
    ).toBe("DatabaseLifecycleLockedError: database in use\n    at acquire");
  });
});
