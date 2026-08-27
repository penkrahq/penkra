import type { OrchestrationEvent, OrchestrationSyncSnapshot } from "@penkra/contracts";
import { Effect, PubSub, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { makeDurableOrchestrationStream } from "./wsDurableOrchestrationStream";

const event = (sequence: number) => ({ sequence }) as OrchestrationEvent;
const snapshot = (snapshotSequence: number) => ({ snapshotSequence }) as OrchestrationSyncSnapshot;

describe("makeDurableOrchestrationStream", () => {
  it("replays every durable event when many live notifications collapse into one wake", async () => {
    const items = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const live = yield* PubSub.unbounded<OrchestrationEvent>();
          let highWater = 100;
          let publishedSecondBurst = false;
          return yield* makeDurableOrchestrationStream({
            subscribeLive: PubSub.subscribe(live).pipe(
              Effect.map((subscription) => Stream.fromEffectRepeat(PubSub.take(subscription))),
            ),
            snapshot: Effect.succeed(snapshot(0)),
            getHighWaterSequence: Effect.sync(() => highWater),
            replay: (from, through) => {
              const replayed = Array.from({ length: through - from }, (_, index) =>
                event(from + index + 1),
              );
              if (through === 100 && !publishedSecondBurst) {
                publishedSecondBurst = true;
                return Stream.concat(
                  Stream.fromEffect(
                    Effect.gen(function* () {
                      highWater = 200;
                      for (let sequence = 101; sequence <= 200; sequence += 1) {
                        yield* PubSub.publish(live, event(sequence));
                      }
                    }),
                  ).pipe(Stream.drain),
                  Stream.fromIterable(replayed),
                );
              }
              return Stream.fromIterable(replayed);
            },
          }).pipe(Stream.take(201), Stream.runCollect);
        }),
      ),
    );

    expect(
      Array.from(items).map((item) => (item.kind === "snapshot" ? 0 : item.event.sequence)),
    ).toEqual(Array.from({ length: 201 }, (_, sequence) => sequence));
  });

  it("resumes directly from an acknowledged cursor without sending a snapshot", async () => {
    const items = await Effect.runPromise(
      Effect.scoped(
        makeDurableOrchestrationStream({
          afterSequenceExclusive: 7,
          subscribeLive: Effect.succeed(Stream.empty),
          snapshot: Effect.die("snapshot should not run"),
          getHighWaterSequence: Effect.succeed(10),
          replay: (from, through) =>
            Stream.fromIterable(
              Array.from({ length: through - from }, (_, index) => event(from + index + 1)),
            ),
        }).pipe(Stream.take(3), Stream.runCollect),
      ),
    );

    expect(Array.from(items).map((item) => item.kind === "event" && item.event.sequence)).toEqual([
      8, 9, 10,
    ]);
  });

  it("sends an authoritative snapshot when the client cursor is ahead of the log", async () => {
    const items = await Effect.runPromise(
      Effect.scoped(
        makeDurableOrchestrationStream({
          afterSequenceExclusive: 500,
          subscribeLive: Effect.succeed(Stream.empty),
          snapshot: Effect.succeed(snapshot(10)),
          getHighWaterSequence: Effect.succeed(10),
          replay: () => Stream.empty,
        }).pipe(Stream.take(1), Stream.runCollect),
      ),
    );

    expect(Array.from(items)).toEqual([{ kind: "snapshot", snapshot: snapshot(10) }]);
  });
});
