import { randomBytes } from "node:crypto";
import { Effect } from "effect";
import { DIAGNOSTIC_LIMITS } from "./limits";
import type { DiagnosticsStore } from "./store";
import { runStartupStage } from "../startupTiming";

export type BootStage =
  | "provider-native-state-deletion.recover"
  | "provider-connection-lifecycle.recover"
  | "provider-connection-login.recover"
  | "default-spaces.ensure"
  | "http-runtime.start";

export function measuredBootStage<A, E, R>(
  stage: BootStage,
  effect: Effect.Effect<A, E, R>,
  durations: Array<{ stage: BootStage; elapsedMs: number }>,
  onStart?: (stage: BootStage) => void,
): Effect.Effect<A, E, R> {
  return Effect.sync(() => {
    onStart?.(stage);
    return performance.now();
  }).pipe(
    Effect.flatMap((startedAt) =>
      runStartupStage(stage, effect).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            durations.push({ stage, elapsedMs: Math.round(performance.now() - startedAt) });
          }),
        ),
      ),
    ),
  );
}

export function recordBootSlow(
  store: DiagnosticsStore,
  traceId: string,
  elapsedMs: number,
  stage?: BootStage,
): void {
  store.incident({
    traceId,
    spanId: randomBytes(8).toString("hex"),
    kind: "timeout",
    code: "BOOT_SLOW",
    where: "server.boot",
    severity: "warn",
    expected: { deadlineMs: DIAGNOSTIC_LIMITS.bootMs },
    actual: { elapsedMs },
    ...(stage ? { context: { bootStage: stage } } : {}),
    lastCheckpoint: "server.starting",
  });
}

export function recordBootReady(
  store: DiagnosticsStore,
  traceId: string,
  elapsedMs: number,
  durations: ReadonlyArray<{ stage: BootStage; elapsedMs: number }>,
  alreadyReported = false,
): void {
  store.checkpoint({
    traceId,
    spanId: randomBytes(8).toString("hex"),
    flow: "boot",
    step: "server.ready",
    outcome: "ok",
    elapsedMs,
  });
  if (elapsedMs <= DIAGNOSTIC_LIMITS.bootMs || alreadyReported) return;
  const slowest = durations.reduce<(typeof durations)[number] | null>(
    (current, item) => (current === null || item.elapsedMs > current.elapsedMs ? item : current),
    null,
  );
  recordBootSlow(store, traceId, elapsedMs, slowest?.stage);
}
