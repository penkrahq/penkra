import { Cause, Duration, Effect, Exit, Option, Scope } from "effect";

import type {
  ProviderIntentOutboxJob,
  ProviderIntentOutboxShape,
} from "../persistence/Services/ProviderIntentOutbox.ts";
import type { PersistenceDecodeError, PersistenceSqlError } from "../persistence/Errors.ts";
import { isProviderIntentEvent } from "./providerIntentClassification.ts";

export type ProviderIntentOutcome =
  | { readonly state: "succeeded" }
  | { readonly state: "retry" | "dead" | "uncertain"; readonly detail: string };

export interface ProviderIntentOutboxWorkerOptions {
  readonly maxActiveLanes?: number;
  readonly pollIntervalMs?: number;
  readonly callDeadlineMs?: number;
  readonly claimLeaseMs?: number;
}

/**
 * A bounded scheduler for durable provider-session lanes. A job is claimed
 * only if every older job in its lane is terminal. The database owns the
 * ordering rule; this in-memory set merely avoids duplicate local workers.
 */
export const startProviderIntentOutboxWorker = <E, R>(input: {
  readonly outbox: ProviderIntentOutboxShape;
  readonly process: (job: ProviderIntentOutboxJob) => Effect.Effect<ProviderIntentOutcome, E, R>;
  readonly options?: ProviderIntentOutboxWorkerOptions;
}): Effect.Effect<void, PersistenceSqlError | PersistenceDecodeError, Scope.Scope | R> =>
  Effect.gen(function* () {
    const maxActiveLanes = Math.max(1, Math.min(input.options?.maxActiveLanes ?? 8, 32));
    const pollIntervalMs = Math.max(10, input.options?.pollIntervalMs ?? 100);
    const callDeadlineMs = Math.max(1_000, input.options?.callDeadlineMs ?? 120_000);
    const claimLeaseMs = Math.max(callDeadlineMs + 10_000, input.options?.claimLeaseMs ?? 130_000);
    const activeLanes = new Set<string>();
    const ownerPrefix = `provider-lane:${crypto.randomUUID()}`;

    const runJob = (job: ProviderIntentOutboxJob) =>
      Effect.gen(function* () {
        const now = new Date().toISOString();
        const claim = yield* input.outbox.claimLaneHead({
          eventSequence: job.eventSequence,
          laneKey: job.laneKey,
          owner: `${ownerPrefix}:${job.eventSequence}`,
          now,
          expiresAt: new Date(Date.now() + claimLeaseMs).toISOString(),
        });
        if (Option.isNone(claim)) return;
        const claimed = claim.value;
        const outcome = !isProviderIntentEvent(claimed.event)
          ? ({ state: "dead", detail: "Outbox job is not a provider intent." } as const)
          : yield* input.process(claimed).pipe(
              Effect.timeoutOption(Duration.millis(callDeadlineMs)),
              Effect.exit,
              Effect.map((exit): ProviderIntentOutcome => {
                if (Exit.isSuccess(exit)) {
                  return Option.getOrElse(exit.value, () => ({
                    state: "uncertain" as const,
                    detail: "Provider call exceeded its deadline without an acceptance result.",
                  }));
                }
                return {
                  state: "uncertain",
                  detail: Cause.hasInterruptsOnly(exit.cause)
                    ? "Provider call was interrupted before an acceptance result was recorded."
                    : "Provider call failed without a classified acceptance result.",
                };
              }),
            );
        const finalOutcome: ProviderIntentOutcome =
          outcome.state === "retry" && claimed.attemptCount >= 3
            ? { state: "dead", detail: `Safe retry budget exhausted. ${outcome.detail}` }
            : outcome;
        const settled = yield* input.outbox.settleClaim({
          eventSequence: claimed.eventSequence,
          owner: claimed.claimOwner!,
          generation: claimed.claimGeneration,
          state: finalOutcome.state,
          at: new Date().toISOString(),
          ...(finalOutcome.state === "succeeded" ? {} : { error: finalOutcome.detail }),
        });
        if (!settled) {
          yield* Effect.logError("provider outbox claim lost settlement ownership", {
            eventSequence: claimed.eventSequence,
            laneKey: claimed.laneKey,
            generation: claimed.claimGeneration,
          });
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logError("provider outbox worker failed", {
                eventSequence: job.eventSequence,
                laneKey: job.laneKey,
                cause: Cause.pretty(cause),
              }),
        ),
        Effect.ensuring(Effect.sync(() => activeLanes.delete(job.laneKey))),
      );

    yield* Effect.forever(
      Effect.gen(function* () {
        if (activeLanes.size < maxActiveLanes) {
          const heads = yield* input.outbox.listRunnableLaneHeads(maxActiveLanes * 2);
          for (const head of heads) {
            if (activeLanes.size >= maxActiveLanes) break;
            if (activeLanes.has(head.laneKey)) continue;
            activeLanes.add(head.laneKey);
            yield* Effect.forkScoped(runJob(head));
          }
        }
        yield* Effect.sleep(Duration.millis(pollIntervalMs));
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logError("provider outbox poll failed", { cause: Cause.pretty(cause) }).pipe(
                Effect.andThen(Effect.sleep(Duration.seconds(1))),
              ),
        ),
      ),
    );
  });
