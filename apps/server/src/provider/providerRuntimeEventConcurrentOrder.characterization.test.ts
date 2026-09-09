import { Deferred, Effect, Fiber, PubSub, Stream } from "effect";
import { EventId, ThreadId, TurnId, type ProviderRuntimeEvent } from "@penkra/contracts";
import { describe, expect, it } from "vitest";

import { runProviderRuntimeEventPump } from "./providerRuntimeEventPump.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-provider-event-concurrent-order");
const TURN_ID = TurnId.makeUnsafe("turn-provider-event-concurrent-order");

const event = (
  eventId: string,
  type: "turn.started" | "runtime.error",
  createdAt: string,
): ProviderRuntimeEvent =>
  ({
    type,
    eventId: EventId.makeUnsafe(eventId),
    provider: "codex",
    threadId: THREAD_ID,
    turnId: TURN_ID,
    createdAt,
    payload:
      type === "turn.started"
        ? {}
        : {
            message: "Authentication required",
            class: "provider_error",
            detail: {
              error: {
                message: "Authentication required",
                additionalDetails: "concurrent held-persistence fixture",
              },
              willRetry: false,
            },
          },
  }) as ProviderRuntimeEvent;

describe("provider runtime event concurrent order characterization", () => {
  it("preserves sequential producer order across a held synthetic persistence callback", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const bus = yield* PubSub.unbounded<ProviderRuntimeEvent>();
          const releasePersistence = yield* Deferred.make<void>();
          const firstCallbackEntered = yield* Deferred.make<void>();
          const first = event(
            "event-sequential-turn-started",
            "turn.started",
            "2026-09-07T11:01:01.000Z",
          );
          const second = event(
            "event-sequential-auth-error",
            "runtime.error",
            "2026-09-07T11:01:02.000Z",
          );
          const producerEmissionOrder: string[] = [];
          const callbackEntryOrder: string[] = [];
          // This array records completion of the synthetic processEvent callback; it is not a SQLite journal.
          const persistenceCallbackCompletions: Array<{
            readonly sequence: number;
            readonly eventId: string;
            readonly createdAt: string;
          }> = [];

          const pumpFiber = yield* runProviderRuntimeEventPump({
            provider: "codex",
            stream: Stream.fromPubSub(bus),
            processEvent: (incoming) =>
              Effect.gen(function* () {
                callbackEntryOrder.push(incoming.eventId);
                if (incoming.eventId === first.eventId) {
                  yield* Deferred.succeed(firstCallbackEntered, undefined);
                  yield* Deferred.await(releasePersistence);
                }
                persistenceCallbackCompletions.push({
                  sequence: persistenceCallbackCompletions.length + 1,
                  eventId: incoming.eventId,
                  createdAt: incoming.createdAt,
                });
              }),
            updateHealth: () => undefined,
            retryBaseDelayMs: 1,
            retryMaxDelayMs: 2,
          }).pipe(Effect.forkScoped);

          const producer = yield* Effect.gen(function* () {
            producerEmissionOrder.push(first.eventId);
            yield* PubSub.publish(bus, first);
            producerEmissionOrder.push(second.eventId);
            yield* PubSub.publish(bus, second);
          }).pipe(Effect.forkScoped);
          yield* Deferred.await(firstCallbackEntered);
          expect(producerEmissionOrder).toEqual([first.eventId]);
          expect(callbackEntryOrder).toEqual([first.eventId]);
          expect(persistenceCallbackCompletions).toEqual([]);

          yield* Deferred.succeed(releasePersistence, undefined);
          yield* Fiber.join(producer);
          yield* waitForEffect(() => persistenceCallbackCompletions.length === 2);
          yield* Fiber.interrupt(pumpFiber);

          expect(producerEmissionOrder).toEqual([first.eventId, second.eventId]);
          expect(callbackEntryOrder).toEqual([first.eventId, second.eventId]);
          expect(persistenceCallbackCompletions).toEqual([
            { sequence: 1, eventId: first.eventId, createdAt: first.createdAt },
            { sequence: 2, eventId: second.eventId, createdAt: second.createdAt },
          ]);
        }),
      ),
    );
  }, 5_000);

  it("serializes concurrent producers across a held synthetic persistence callback", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const bus = yield* PubSub.unbounded<ProviderRuntimeEvent>();
          const releasePersistence = yield* Deferred.make<void>();
          const firstCallbackEntered = yield* Deferred.make<void>();
          const secondProducerPublished = yield* Deferred.make<void>();
          const first = event(
            "event-concurrent-turn-started",
            "turn.started",
            "2026-09-07T11:00:01.000Z",
          );
          const second = event(
            "event-concurrent-auth-error",
            "runtime.error",
            "2026-09-07T11:00:02.000Z",
          );
          const producerEmissionOrder: string[] = [];
          const callbackEntryOrder: string[] = [];
          // This array records completion of the synthetic processEvent callback; it is not a SQLite journal.
          const persistenceCallbackCompletions: Array<{
            readonly sequence: number;
            readonly eventId: string;
            readonly createdAt: string;
          }> = [];

          const pumpFiber = yield* runProviderRuntimeEventPump({
            provider: "codex",
            stream: Stream.fromPubSub(bus),
            processEvent: (incoming) =>
              Effect.gen(function* () {
                callbackEntryOrder.push(incoming.eventId);
                if (incoming.eventId === first.eventId) {
                  yield* Deferred.succeed(firstCallbackEntered, undefined);
                  yield* Deferred.await(releasePersistence);
                }
                persistenceCallbackCompletions.push({
                  sequence: persistenceCallbackCompletions.length + 1,
                  eventId: incoming.eventId,
                  createdAt: incoming.createdAt,
                });
              }),
            updateHealth: () => undefined,
            retryBaseDelayMs: 1,
            retryMaxDelayMs: 2,
          }).pipe(Effect.forkScoped);

          const producerA = yield* Effect.gen(function* () {
            producerEmissionOrder.push(first.eventId);
            yield* PubSub.publish(bus, first);
          }).pipe(Effect.forkScoped);
          yield* Deferred.await(firstCallbackEntered);

          const producerB = yield* Effect.gen(function* () {
            producerEmissionOrder.push(second.eventId);
            yield* PubSub.publish(bus, second);
            yield* Deferred.succeed(secondProducerPublished, undefined);
          }).pipe(Effect.forkScoped);
          yield* Deferred.await(secondProducerPublished);

          expect(producerEmissionOrder).toEqual([first.eventId, second.eventId]);
          expect(callbackEntryOrder).toEqual([first.eventId]);
          expect(persistenceCallbackCompletions).toEqual([]);

          yield* Deferred.succeed(releasePersistence, undefined);
          yield* Fiber.join(producerA);
          yield* Fiber.join(producerB);
          yield* waitForEffect(() => persistenceCallbackCompletions.length === 2);
          yield* Fiber.interrupt(pumpFiber);

          expect(callbackEntryOrder).toEqual([first.eventId, second.eventId]);
          expect(persistenceCallbackCompletions).toEqual([
            { sequence: 1, eventId: first.eventId, createdAt: first.createdAt },
            { sequence: 2, eventId: second.eventId, createdAt: second.createdAt },
          ]);
        }),
      ),
    );
  }, 5_000);
});

function waitForEffect(predicate: () => boolean, remainingMs = 1_000): Effect.Effect<void, Error> {
  if (predicate()) return Effect.void;
  if (remainingMs <= 0)
    return Effect.fail(new Error("Timed out waiting for concurrent event fixture"));
  return Effect.sleep(5).pipe(Effect.andThen(waitForEffect(predicate, remainingMs - 5)));
}
