import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { QueuedTurnPromotionRepository } from "../Services/QueuedTurnPromotions.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { QueuedTurnPromotionRepositoryLive } from "./QueuedTurnPromotions.ts";

const layer = it.layer(
  QueuedTurnPromotionRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("QueuedTurnPromotionRepository", (it) => {
  it.effect("replays only the same durable queued-message action", () =>
    Effect.gen(function* () {
      const repository = yield* QueuedTurnPromotionRepository;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-08-12T00:00:00.000Z";
      const rows = yield* sql<{ readonly sequence: number }>`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, command_id, causation_event_id, correlation_id,
          actor_kind, payload_json, metadata_json
        ) VALUES (
          'evt-action-source', 'thread', 'thread-action', 0,
          'thread.turn-queued', ${now}, 'cmd-action-source',
          NULL, NULL, 'server', '{}', '{}'
        )
        RETURNING sequence
      `;
      yield* repository.enqueue({
        queuedEventSequence: rows[0]!.sequence,
        threadId: "thread-action",
        messageId: "message-action",
        dispatchMode: "queue",
        createdAt: now,
      });

      const first = yield* repository.claimMessageAction({
        threadId: "thread-action",
        messageId: "message-action",
        actionKind: "steer",
        actionEventId: "evt-steer-action",
        updatedAt: now,
      });
      assert.deepInclude(first.pipe(Option.getOrThrow), {
        state: "cancelled",
        actionKind: "steer",
        actionEventId: "evt-steer-action",
      });

      const replay = yield* repository.claimMessageAction({
        threadId: "thread-action",
        messageId: "message-action",
        actionKind: "steer",
        actionEventId: "evt-steer-action",
        updatedAt: now,
      });
      assert.isTrue(Option.isSome(replay));

      const unrelated = yield* repository.claimMessageAction({
        threadId: "thread-action",
        messageId: "message-action",
        actionKind: "cancel",
        actionEventId: "evt-cancel-action",
        updatedAt: now,
      });
      assert.isTrue(Option.isNone(unrelated));

      const nextRows = yield* sql<{ readonly sequence: number }>`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, command_id, causation_event_id, correlation_id,
          actor_kind, payload_json, metadata_json
        ) VALUES (
          'evt-action-source-next', 'thread', 'thread-action', 1,
          'thread.turn-queued', ${now}, 'cmd-action-source-next',
          NULL, NULL, 'server', '{}', '{}'
        )
        RETURNING sequence
      `;
      yield* repository.enqueue({
        queuedEventSequence: nextRows[0]!.sequence,
        threadId: "thread-action",
        messageId: "message-action",
        dispatchMode: "queue",
        createdAt: now,
      });

      const oldReplayAfterNewGeneration = yield* repository.claimMessageAction({
        threadId: "thread-action",
        messageId: "message-action",
        actionKind: "steer",
        actionEventId: "evt-steer-action",
        updatedAt: now,
      });
      assert.strictEqual(
        oldReplayAfterNewGeneration.pipe(Option.getOrThrow).queuedEventSequence,
        rows[0]!.sequence,
      );
      assert.isTrue(
        yield* repository.hasPendingMessage({
          threadId: "thread-action",
          messageId: "message-action",
        }),
      );
    }),
  );

  it.effect(
    "preserves priority, reclaims foreign owners, and permits a later message generation",
    () =>
      Effect.gen(function* () {
        const repository = yield* QueuedTurnPromotionRepository;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-07-14T00:00:00.000Z";
        const insertSourceEvent = (id: number) =>
          sql<{ readonly sequence: number }>`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type,
            occurred_at, command_id, causation_event_id, correlation_id,
            actor_kind, payload_json, metadata_json
          ) VALUES (
            ${`evt-queued-promotion-${id}`}, 'thread', 'thread-queued-promotion', ${id - 1},
            'thread.turn-queued', ${now}, ${`cmd-queued-promotion-${id}`},
            NULL, NULL, 'server', '{}', '{}'
          )
          RETURNING sequence
        `.pipe(Effect.map((rows) => rows[0]!.sequence));

        const queuedSequence = yield* insertSourceEvent(1);
        const steerSequence = yield* insertSourceEvent(2);
        yield* repository.enqueue({
          queuedEventSequence: queuedSequence,
          threadId: "thread-queued-promotion",
          messageId: "message-queue",
          dispatchMode: "queue",
          createdAt: now,
        });
        yield* repository.enqueue({
          queuedEventSequence: steerSequence,
          threadId: "thread-queued-promotion",
          messageId: "message-steer",
          dispatchMode: "steer",
          createdAt: now,
        });

        const firstClaim = yield* repository.claimNext({
          threadId: "thread-queued-promotion",
          claimOwner: "owner-before-crash",
          claimedAt: now,
          claimExpiresAt: "2099-01-01T00:00:00.000Z",
        });
        assert.strictEqual(firstClaim.pipe(Option.getOrThrow).queuedEventSequence, steerSequence);

        const reclaimed = yield* repository.claimNext({
          threadId: "thread-queued-promotion",
          claimOwner: "owner-after-restart",
          claimedAt: now,
          claimExpiresAt: "2099-01-01T00:00:00.000Z",
        });
        assert.deepInclude(reclaimed.pipe(Option.getOrThrow), {
          queuedEventSequence: steerSequence,
          attemptCount: 2,
        });
        assert.isTrue(
          yield* repository.markPromoted({
            queuedEventSequence: steerSequence,
            claimOwner: "owner-after-restart",
            promotedAt: now,
          }),
        );

        const nextClaim = yield* repository.claimNext({
          threadId: "thread-queued-promotion",
          claimOwner: "owner-after-restart",
          claimedAt: now,
          claimExpiresAt: "2099-01-01T00:00:00.000Z",
        });
        assert.strictEqual(nextClaim.pipe(Option.getOrThrow).queuedEventSequence, queuedSequence);
        yield* repository.releaseClaim({
          queuedEventSequence: queuedSequence,
          claimOwner: "owner-after-restart",
          updatedAt: now,
        });

        const laterSteerSequence = yield* insertSourceEvent(3);
        yield* repository.enqueue({
          queuedEventSequence: laterSteerSequence,
          threadId: "thread-queued-promotion",
          messageId: "message-steer",
          dispatchMode: "steer",
          createdAt: now,
        });
        const laterGeneration = yield* repository.claimNext({
          threadId: "thread-queued-promotion",
          claimOwner: "owner-later-generation",
          claimedAt: now,
          claimExpiresAt: "2099-01-01T00:00:00.000Z",
        });
        assert.strictEqual(
          laterGeneration.pipe(Option.getOrThrow).queuedEventSequence,
          laterSteerSequence,
        );

        // `laterSteerSequence` is currently claimed ('promoting'). cancelThread now
        // widens to cancel BOTH 'queued' and 'promoting' rows, so the in-flight
        // claim is cancelled immediately -> nothing pending.
        yield* repository.cancelThread({
          threadId: "thread-queued-promotion",
          updatedAt: now,
        });
        assert.isFalse(
          yield* repository.hasPendingMessage({
            threadId: "thread-queued-promotion",
            messageId: "message-steer",
          }),
        );

        // The drain's error path releasing the (now cancelled) claim must NOT
        // resurrect it: releaseClaim only matches state='promoting', which the
        // cancelled row no longer is, so it reports no-op and the row stays dead.
        const released = yield* repository.releaseClaim({
          queuedEventSequence: laterSteerSequence,
          claimOwner: "owner-later-generation",
          updatedAt: now,
        });
        assert.isFalse(released);
        assert.isFalse(
          yield* repository.hasPendingMessage({
            threadId: "thread-queued-promotion",
            messageId: "message-steer",
          }),
        );
      }),
  );
});
