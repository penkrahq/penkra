import type { OrchestrationEvent, OrchestrationSyncSnapshot } from "@penkra/contracts";
import { Effect, Queue, Ref, Scope, Stream } from "effect";

export type DurableOrchestrationStreamItem =
  | { readonly kind: "snapshot"; readonly snapshot: OrchestrationSyncSnapshot }
  | { readonly kind: "event"; readonly event: OrchestrationEvent };

/**
 * Deliver orchestration events from the durable log, using the hot stream only
 * as a conflated wake-up signal. A slow client can therefore delay only its own
 * cursor; it cannot backpressure command dispatch or lose a bounded live buffer.
 */
export function makeDurableOrchestrationStream<E>(input: {
  readonly afterSequenceExclusive?: number;
  readonly subscribeLive: Effect.Effect<Stream.Stream<OrchestrationEvent>, never, Scope.Scope>;
  readonly snapshot: Effect.Effect<OrchestrationSyncSnapshot, E>;
  readonly getHighWaterSequence: Effect.Effect<number, E>;
  readonly replay: (
    fromSequenceExclusive: number,
    throughSequenceInclusive: number,
  ) => Stream.Stream<OrchestrationEvent, E>;
  readonly onReplayRange?: (range: {
    readonly fromSequenceExclusive: number;
    readonly throughSequenceInclusive: number;
    readonly eventCount: number;
  }) => Effect.Effect<void>;
}): Stream.Stream<DurableOrchestrationStreamItem, E> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const live = yield* input.subscribeLive;
      const wake = yield* Queue.sliding<void>(1);
      yield* Stream.runForEach(live, () => Queue.offer(wake, undefined)).pipe(Effect.forkScoped);

      const attachHighWater = yield* input.getHighWaterSequence;
      // A cursor ahead of the current log can happen after restoring or replacing
      // server state. Treat it as a reset boundary instead of waiting forever for
      // a sequence the current log may never reach.
      const snapshot =
        input.afterSequenceExclusive === undefined || input.afterSequenceExclusive > attachHighWater
          ? yield* input.snapshot
          : undefined;
      const initialCursor = input.afterSequenceExclusive ?? snapshot?.snapshotSequence ?? 0;
      const authoritativeInitialCursor = snapshot?.snapshotSequence ?? initialCursor;
      const cursor = yield* Ref.make(authoritativeInitialCursor);

      const replayThrough = (throughSequenceInclusive: number) =>
        Stream.unwrap(
          Ref.get(cursor).pipe(
            Effect.map((fromSequenceExclusive) =>
              throughSequenceInclusive <= fromSequenceExclusive
                ? Stream.empty
                : Stream.concat(
                    Stream.fromEffect(
                      input.onReplayRange?.({
                        fromSequenceExclusive,
                        throughSequenceInclusive,
                        eventCount: throughSequenceInclusive - fromSequenceExclusive,
                      }) ?? Effect.void,
                    ).pipe(Stream.drain),
                    input.replay(fromSequenceExclusive, throughSequenceInclusive).pipe(
                      Stream.tap((event) => Ref.set(cursor, event.sequence)),
                      Stream.map(
                        (event): DurableOrchestrationStreamItem => ({ kind: "event", event }),
                      ),
                    ),
                  ),
            ),
          ),
        );

      const initialHighWater = yield* input.getHighWaterSequence;
      const initial = Stream.concat(
        snapshot
          ? Stream.succeed<DurableOrchestrationStreamItem>({ kind: "snapshot", snapshot })
          : Stream.empty,
        replayThrough(initialHighWater),
      );
      const following = Stream.fromQueue(wake).pipe(
        Stream.flatMap(() =>
          Stream.unwrap(input.getHighWaterSequence.pipe(Effect.map(replayThrough))),
        ),
      );

      return Stream.concat(initial, following);
    }),
  );
}
