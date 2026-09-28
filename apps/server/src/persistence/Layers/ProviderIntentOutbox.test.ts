import { EventId, ThreadId } from "@penkra/contracts";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { isProviderIntentEvent } from "../../orchestration/providerIntentClassification.ts";
import { startProviderIntentOutboxWorker } from "../../orchestration/providerIntentOutboxWorker.ts";
import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";
import { ProviderIntentOutbox } from "../Services/ProviderIntentOutbox.ts";
import { OrchestrationEventStoreLive } from "./OrchestrationEventStore.ts";
import { ProviderIntentOutboxLive } from "./ProviderIntentOutbox.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  Layer.mergeAll(OrchestrationEventStoreLive, ProviderIntentOutboxLive).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

layer("ProviderIntentOutbox", (it) => {
  it.effect("runs B while A is blocked and keeps A's next job ordered", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const events = yield* OrchestrationEventStore;
        const outbox = yield* ProviderIntentOutbox;
        const now = "2026-09-28T00:00:00.000Z";
        yield* sql`DELETE FROM provider_intent_outbox`;
        const append = (eventId: string, threadId: string) =>
          sql.withTransaction(
            Effect.gen(function* () {
              const event = yield* events.append({
                type: "thread.archived",
                eventId: EventId.makeUnsafe(eventId),
                aggregateKind: "thread",
                aggregateId: ThreadId.makeUnsafe(threadId),
                occurredAt: now,
                commandId: null,
                causationEventId: null,
                correlationId: null,
                metadata: {},
                payload: {
                  threadId: ThreadId.makeUnsafe(threadId),
                  archivedAt: now,
                  updatedAt: now,
                },
              });
              if (!isProviderIntentEvent(event)) {
                return yield* Effect.die(new Error("Expected provider intent"));
              }
              yield* outbox.enqueueInCurrentTransaction(event);
            }),
          );
        yield* append("event-a-one", "thread-a");
        yield* append("event-a-two", "thread-a");
        yield* append("event-b-one", "thread-b");

        const aEntered = yield* Deferred.make<void>();
        const releaseA = yield* Deferred.make<void>();
        const aTwoEntered = yield* Deferred.make<void>();
        const bEntered = yield* Deferred.make<void>();
        yield* startProviderIntentOutboxWorker({
          outbox,
          process: (job) =>
            job.eventId === "event-a-one"
              ? Deferred.succeed(aEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseA)),
                  Effect.as({ state: "succeeded" as const }),
                )
              : job.eventId === "event-a-two"
                ? Deferred.succeed(aTwoEntered, undefined).pipe(
                    Effect.as({ state: "succeeded" as const }),
                  )
                : Deferred.succeed(bEntered, undefined).pipe(
                    Effect.as({ state: "succeeded" as const }),
                  ),
          options: { pollIntervalMs: 10, maxActiveLanes: 2 },
        }).pipe(Effect.forkScoped);

        yield* Deferred.await(aEntered);
        yield* Deferred.await(bEntered);
        const beforeRelease = yield* sql<{ readonly state: string }>`
          SELECT state FROM provider_intent_outbox WHERE event_id = 'event-a-two'
        `;
        assert.equal(beforeRelease[0]?.state, "pending");
        yield* Deferred.succeed(releaseA, undefined);
        yield* TestClock.adjust("100 millis");
        yield* Deferred.await(aTwoEntered);
      }),
    ),
  );

  it.effect("commits an event snapshot with its lane and rolls both back together", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const events = yield* OrchestrationEventStore;
      const outbox = yield* ProviderIntentOutbox;
      const now = "2026-09-28T00:00:00.000Z";
      yield* sql`DELETE FROM provider_intent_outbox`;
      const cutover = yield* outbox.getLegacyCutover();
      assert.equal(cutover.drainedAt, null);

      yield* sql`
        INSERT INTO projection_threads (
          thread_id, folder_id, title, model_selection_json, runtime_mode,
          parent_thread_id, created_at, updated_at
        ) VALUES
          ('lane-parent', 'test-folder', 'Parent', '{"provider":"codex","model":"gpt-5.5"}',
           'full-access', NULL, ${now}, ${now}),
          ('lane-child', 'test-folder', 'Child', '{"provider":"codex","model":"gpt-5.5"}',
           'full-access', 'lane-parent', ${now}, ${now}),
          ('lane-fork', 'test-folder', 'Fork', '{"provider":"codex","model":"gpt-5.5"}',
           'full-access', NULL, ${now}, ${now})
      `;

      const appendIntent = (id: string, threadId: string) =>
        Effect.gen(function* () {
          const event = yield* events.append({
            type: "thread.archived",
            eventId: EventId.makeUnsafe(id),
            aggregateKind: "thread",
            aggregateId: ThreadId.makeUnsafe(threadId),
            occurredAt: now,
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            payload: {
              threadId: ThreadId.makeUnsafe(threadId),
              archivedAt: now,
              updatedAt: now,
            },
          });
          if (!isProviderIntentEvent(event)) {
            return yield* Effect.die(new Error("Expected a provider intent"));
          }
          yield* outbox.enqueueInCurrentTransaction(event);
          return event;
        });

      const child = yield* sql.withTransaction(appendIntent("evt-child", "lane-child"));
      const childNext = yield* sql.withTransaction(appendIntent("evt-child-next", "lane-child"));
      const fork = yield* sql.withTransaction(appendIntent("evt-fork", "lane-fork"));
      const jobs = yield* outbox.readPending(10);
      assert.deepStrictEqual(
        jobs.map((job) => [job.eventSequence, job.laneKey, job.event.eventId]),
        [
          [child.sequence, "lane-parent", child.eventId],
          [childNext.sequence, "lane-parent", childNext.eventId],
          [fork.sequence, "lane-fork", fork.eventId],
        ],
      );

      assert.deepStrictEqual(
        (yield* outbox.listRunnableLaneHeads(10)).map((job) => job.eventSequence),
        [child.sequence, fork.sequence],
      );
      const childClaim = yield* outbox.claimLaneHead({
        eventSequence: child.sequence,
        laneKey: "lane-parent",
        owner: "owner-a",
        now,
        expiresAt: "2026-09-28T00:01:00.000Z",
      });
      assert.equal(childClaim._tag, "Some");
      assert.deepStrictEqual(
        (yield* outbox.listRunnableLaneHeads(10)).map((job) => job.eventSequence),
        [fork.sequence],
      );
      const forkClaim = yield* outbox.claimLaneHead({
        eventSequence: fork.sequence,
        laneKey: "lane-fork",
        owner: "owner-b",
        now,
        expiresAt: "2026-09-28T00:01:00.000Z",
      });
      assert.equal(forkClaim._tag, "Some");
      const afterExpiry = "2026-09-28T00:02:00.000Z";
      assert.deepStrictEqual(
        (yield* outbox.listExpiredClaims(afterExpiry)).map((job) => job.eventSequence),
        [child.sequence, fork.sequence],
      );
      assert.equal(
        yield* outbox.settleExpiredClaim({
          eventSequence: fork.sequence,
          owner: "owner-b",
          generation: 1,
          now: afterExpiry,
          state: "uncertain",
          error: "Acceptance was not recorded before the lease expired.",
        }),
        true,
      );
      assert.equal(
        yield* outbox.abandonAfterFence({ eventSequence: fork.sequence, at: afterExpiry }),
        true,
      );
      assert.equal(
        yield* outbox.settleClaim({
          eventSequence: child.sequence,
          owner: "stale-owner",
          generation: 1,
          state: "succeeded",
          at: now,
        }),
        false,
      );
      assert.equal(
        yield* outbox.settleClaim({
          eventSequence: child.sequence,
          owner: "owner-a",
          generation: 1,
          state: "succeeded",
          at: now,
        }),
        true,
      );
      assert.deepStrictEqual(
        (yield* outbox.listRunnableLaneHeads(10)).map((job) => job.eventSequence),
        [childNext.sequence],
      );

      yield* sql
        .withTransaction(
          appendIntent("evt-rolled-back", "lane-child").pipe(
            Effect.andThen(Effect.fail(new Error("abort transaction"))),
          ),
        )
        .pipe(Effect.flip);
      assert.equal((yield* outbox.readPending(10)).length, 1);
      const rolledBack = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_events WHERE event_id = 'evt-rolled-back'
      `;
      assert.equal(rolledBack[0]?.count, 0);
      assert.equal(yield* outbox.markLegacyDrained(now), true);
      assert.equal((yield* outbox.getLegacyCutover()).drainedAt, now);
    }),
  );
});
