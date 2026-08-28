import * as Crypto from "node:crypto";

import { WsRpcError } from "@penkra/contracts";
import { Effect } from "effect";

interface ActiveSyncLease {
  readonly generation: string;
  readonly deliveryId: string;
  deliveredSequence: number | null;
  acknowledgedSequence: number | null;
}

export interface SyncAcknowledgementLease {
  readonly deliveryId: string;
  readonly recordDelivery: (sequence: number) => Effect.Effect<void, WsRpcError>;
  readonly close: Effect.Effect<void>;
}

/**
 * Tracks a cumulative renderer cursor without putting acknowledgements in the
 * delivery path. WebSocket backpressure bounds writes; this lease only proves
 * which applied sequence the renderer may safely resume after reconnecting.
 */
export function makeSyncAcknowledgements() {
  const active = new Map<number, ActiveSyncLease>();

  const open = (clientId: number): Effect.Effect<SyncAcknowledgementLease> =>
    Effect.gen(function* () {
      const previous = active.get(clientId);
      if (previous) {
        yield* Effect.logInfo("orchestration synchronization connection superseded").pipe(
          Effect.annotateLogs({
            clientId,
            deliveredSequence: previous.deliveredSequence,
            acknowledgedSequence: previous.acknowledgedSequence,
          }),
        );
      }

      const generation = Crypto.randomUUID();
      const lease: ActiveSyncLease = {
        generation,
        deliveryId: Crypto.randomUUID(),
        deliveredSequence: null,
        acknowledgedSequence: null,
      };
      active.set(clientId, lease);
      yield* Effect.logDebug("orchestration synchronization acknowledgement lease opened").pipe(
        Effect.annotateLogs({ clientId, generation, deliveryId: lease.deliveryId }),
      );

      const recordDelivery = (sequence: number) =>
        Effect.gen(function* () {
          if (active.get(clientId) !== lease) {
            return yield* supersededError();
          }
          if (lease.deliveredSequence !== null && sequence < lease.deliveredSequence) {
            return yield* new WsRpcError({
              message: "Orchestration synchronization delivery sequence regressed.",
              code: "SYNC_DELIVERY_SEQUENCE_REGRESSION",
              retryable: true,
            });
          }
          lease.deliveredSequence = sequence;
        });

      const close = Effect.sync(() => {
        if (active.get(clientId) === lease) {
          active.delete(clientId);
        }
      });

      return { deliveryId: lease.deliveryId, recordDelivery, close };
    });

  const acknowledge = (
    clientId: number,
    input: { readonly deliveryId: string; readonly appliedSequence: number },
  ): Effect.Effect<void, WsRpcError> =>
    Effect.gen(function* () {
      const lease = active.get(clientId);
      if (!lease || lease.deliveryId !== input.deliveryId || lease.deliveredSequence === null) {
        yield* Effect.logWarning("stale orchestration synchronization acknowledgement").pipe(
          Effect.annotateLogs({ clientId, deliveryId: input.deliveryId }),
        );
        return yield* new WsRpcError({
          message: "The synchronization acknowledgement is stale or unknown.",
          code: "SYNC_ACKNOWLEDGEMENT_STALE",
          retryable: false,
        });
      }
      if (input.appliedSequence > lease.deliveredSequence) {
        yield* Effect.logWarning("ahead orchestration synchronization acknowledgement").pipe(
          Effect.annotateLogs({
            clientId,
            appliedSequence: input.appliedSequence,
            deliveredSequence: lease.deliveredSequence,
          }),
        );
        return yield* new WsRpcError({
          message: "The synchronization acknowledgement is ahead of the delivered sequence.",
          code: "SYNC_ACKNOWLEDGEMENT_AHEAD",
          retryable: false,
        });
      }

      const previousAcknowledgedSequence = lease.acknowledgedSequence;
      if (
        previousAcknowledgedSequence !== null &&
        input.appliedSequence <= previousAcknowledgedSequence
      ) {
        yield* Effect.logDebug("redundant orchestration synchronization acknowledgement").pipe(
          Effect.annotateLogs({
            clientId,
            appliedSequence: input.appliedSequence,
            acknowledgedSequence: previousAcknowledgedSequence,
            deliveredSequence: lease.deliveredSequence,
          }),
        );
        return;
      }

      lease.acknowledgedSequence = input.appliedSequence;
      yield* Effect.logDebug("orchestration synchronization acknowledgement received").pipe(
        Effect.annotateLogs({
          clientId,
          deliveryId: lease.deliveryId,
          appliedSequence: input.appliedSequence,
          deliveredSequence: lease.deliveredSequence,
          lagEvents: lease.deliveredSequence - input.appliedSequence,
        }),
      );
    });

  return { open, acknowledge } as const;
}

function supersededError(): WsRpcError {
  return new WsRpcError({
    message: "Orchestration synchronization was superseded by a newer connection.",
    code: "SYNC_SUBSCRIPTION_SUPERSEDED",
    retryable: true,
  });
}
