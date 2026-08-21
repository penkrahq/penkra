import { Clock, Effect } from "effect";

/** Emit deterministic boundaries around every blocking server startup stage. */
export const runStartupStage = <A, E, R>(
  stage: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    yield* Effect.logInfo("server startup stage started", { stage });
    const value = yield* effect;
    const completedAt = yield* Clock.currentTimeMillis;
    yield* Effect.logInfo("server startup stage completed", {
      stage,
      durationMs: completedAt - startedAt,
    });
    return value;
  });
