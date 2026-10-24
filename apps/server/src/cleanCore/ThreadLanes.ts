// Purpose: One admission/delivery lock domain per thread, shared with resumed native dispatch.
import { Effect, Layer, Semaphore, Context } from "effect";

export class ThreadLanes extends Context.Service<
  ThreadLanes,
  {
    readonly run: <A, E, R>(
      threadId: string,
      action: Effect.Effect<A, E, R>,
      kind?: "admission" | "delivery",
    ) => Effect.Effect<A, E, R>;
  }
>()("penkra/cleanCore/ThreadLanes") {}

export const ThreadLanesLive = Layer.effect(
  ThreadLanes,
  Effect.sync(() => {
    const lanes = new Map<
      string,
      { admission: Semaphore.Semaphore; delivery: Semaphore.Semaphore; users: number }
    >();
    return {
      run: <A, E, R>(
        threadId: string,
        action: Effect.Effect<A, E, R>,
        kind: "admission" | "delivery" = "admission",
      ) =>
        Effect.suspend(() => {
          let lane = lanes.get(threadId);
          if (!lane) {
            lane = {
              admission: Semaphore.makeUnsafe(1),
              delivery: Semaphore.makeUnsafe(1),
              users: 0,
            };
            lanes.set(threadId, lane);
          }
          const current = lane;
          current.users++;
          return current[kind]
            .withPermits(1)(action)
            .pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  if (--current.users === 0) lanes.delete(threadId);
                }),
              ),
            );
        }),
    };
  }),
);
