import * as Crypto from "node:crypto";

import { WsRpcError } from "@penkra/contracts";
import { Deferred, Effect } from "effect";

interface PendingDelivery {
  readonly generation: string;
  readonly deliveryId: string;
  readonly expectedSequence: number;
  readonly startedAt: number;
  readonly acknowledged: Deferred.Deferred<boolean>;
}

export interface SyncAcknowledgementLease {
  readonly generation: string;
  readonly beginDelivery: (expectedSequence: number) => Effect.Effect<
    {
      readonly deliveryId: string;
      readonly wait: Effect.Effect<void, WsRpcError>;
    },
    WsRpcError
  >;
  readonly close: Effect.Effect<void>;
}

/** One in-flight delivery per WebSocket client, with reconnect supersession. */
export function makeSyncAcknowledgements() {
  const generations = new Map<number, string>();
  const pending = new Map<number, PendingDelivery>();

  const open = (clientId: number): Effect.Effect<SyncAcknowledgementLease> =>
    Effect.gen(function* () {
      const generation = Crypto.randomUUID();
      const previous = pending.get(clientId);
      if (previous) {
        yield* Effect.logInfo("orchestration synchronization connection superseded").pipe(
          Effect.annotateLogs({ clientId, pendingSequence: previous.expectedSequence }),
        );
        yield* Deferred.succeed(previous.acknowledged, false);
        pending.delete(clientId);
      }
      generations.set(clientId, generation);
      yield* Effect.logDebug("orchestration synchronization acknowledgement lease opened").pipe(
        Effect.annotateLogs({ clientId, generation }),
      );

      const beginDelivery = (expectedSequence: number) =>
        Effect.gen(function* () {
          if (generations.get(clientId) !== generation) {
            return yield* new WsRpcError({
              message: "Orchestration synchronization was superseded by a newer connection.",
              code: "SYNC_SUBSCRIPTION_SUPERSEDED",
              retryable: true,
            });
          }

          const previousDelivery = pending.get(clientId);
          if (previousDelivery) {
            yield* Deferred.succeed(previousDelivery.acknowledged, false);
          }
          const acknowledged = yield* Deferred.make<boolean>();
          const deliveryId = Crypto.randomUUID();
          const delivery: PendingDelivery = {
            generation,
            deliveryId,
            expectedSequence,
            startedAt: Date.now(),
            acknowledged,
          };
          pending.set(clientId, delivery);
          yield* Effect.logDebug("orchestration synchronization delivery opened").pipe(
            Effect.annotateLogs({ clientId, deliveryId, sequence: expectedSequence }),
          );

          yield* Effect.sleep("2 seconds").pipe(
            Effect.flatMap(() =>
              pending.get(clientId) === delivery
                ? Effect.logWarning("orchestration synchronization acknowledgement pending").pipe(
                    Effect.annotateLogs({
                      clientId,
                      sequence: expectedSequence,
                      latencyMs: Date.now() - delivery.startedAt,
                    }),
                  )
                : Effect.void,
            ),
            // The watchdog must outlive beginDelivery itself while the stream
            // waits for the corresponding acknowledgement. Keep it detached;
            // the pending-map identity check makes the delayed observation a
            // no-op after acknowledgement, replacement, or lease closure.
            Effect.forkDetach,
            Effect.asVoid,
          );

          const wait = Deferred.await(acknowledged).pipe(
            Effect.flatMap((accepted) =>
              accepted
                ? Effect.void
                : Effect.fail(
                    new WsRpcError({
                      message:
                        "Orchestration synchronization was superseded by a newer connection.",
                      code: "SYNC_SUBSCRIPTION_SUPERSEDED",
                      retryable: true,
                    }),
                  ),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                if (pending.get(clientId) === delivery) {
                  pending.delete(clientId);
                }
              }),
            ),
          );
          return { deliveryId, wait };
        });

      const close = Effect.gen(function* () {
        if (generations.get(clientId) !== generation) {
          return;
        }
        generations.delete(clientId);
        const delivery = pending.get(clientId);
        if (delivery?.generation === generation) {
          pending.delete(clientId);
          yield* Deferred.succeed(delivery.acknowledged, false);
        }
      });

      return { generation, beginDelivery, close };
    });

  const acknowledge = (
    clientId: number,
    input: { readonly deliveryId: string; readonly appliedSequence: number },
  ): Effect.Effect<void, WsRpcError> =>
    Effect.gen(function* () {
      const delivery = pending.get(clientId);
      if (!delivery || delivery.deliveryId !== input.deliveryId) {
        yield* Effect.logWarning("stale orchestration synchronization acknowledgement").pipe(
          Effect.annotateLogs({ clientId, deliveryId: input.deliveryId }),
        );
        return yield* new WsRpcError({
          message: "The synchronization acknowledgement is stale or unknown.",
          code: "SYNC_ACKNOWLEDGEMENT_STALE",
          retryable: false,
        });
      }
      if (input.appliedSequence < delivery.expectedSequence) {
        yield* Effect.logWarning("behind orchestration synchronization acknowledgement").pipe(
          Effect.annotateLogs({
            clientId,
            appliedSequence: input.appliedSequence,
            expectedSequence: delivery.expectedSequence,
          }),
        );
        return yield* new WsRpcError({
          message: "The synchronization acknowledgement is behind the delivered sequence.",
          code: "SYNC_ACKNOWLEDGEMENT_BEHIND",
          retryable: false,
        });
      }
      const latencyMs = Date.now() - delivery.startedAt;
      if (latencyMs >= 2_000) {
        yield* Effect.logWarning("slow orchestration synchronization acknowledgement").pipe(
          Effect.annotateLogs({
            clientId,
            sequence: delivery.expectedSequence,
            latencyMs,
          }),
        );
      }
      yield* Effect.logDebug("orchestration synchronization acknowledgement received").pipe(
        Effect.annotateLogs({
          clientId,
          deliveryId: delivery.deliveryId,
          sequence: delivery.expectedSequence,
          appliedSequence: input.appliedSequence,
          latencyMs,
        }),
      );
      yield* Deferred.succeed(delivery.acknowledged, true);
    });

  return { open, acknowledge } as const;
}
