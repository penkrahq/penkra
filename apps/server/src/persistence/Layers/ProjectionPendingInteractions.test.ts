import { ThreadId } from "@penkra/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionPendingInteractionRepository } from "../Services/ProjectionPendingInteractions.ts";
import { ProjectionPendingInteractionRepositoryLive } from "./ProjectionPendingInteractions.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionPendingInteractionRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionPendingInteractionRepository", (it) => {
  it.effect("keeps equal provider question ids independent across threads", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionPendingInteractionRepository;
      const requestId = "shared-provider-request";
      const firstThreadId = ThreadId.makeUnsafe("thread-provider-request-a");
      const secondThreadId = ThreadId.makeUnsafe("thread-provider-request-b");
      const base = {
        requestId,
        turnId: null,
        lifecycleGeneration: "generation-a",
        status: "pending" as const,
        responseCommandId: null,
        responseRequestedAt: null,
        createdAt: "2026-07-14T12:00:00.000Z",
        resolvedAt: null,
      };

      yield* repository.upsert({
        ...base,
        interactionKind: "userInput",
        threadId: firstThreadId,
      });
      yield* repository.upsert({
        ...base,
        interactionKind: "userInput",
        threadId: secondThreadId,
      });

      yield* repository.deleteByIdentity({
        threadId: firstThreadId,
        interactionKind: "userInput",
        requestId,
      });
      assert.strictEqual(
        (yield* repository.getByIdentity({
          threadId: firstThreadId,
          interactionKind: "userInput",
          requestId,
        }))._tag,
        "None",
      );
      assert.strictEqual(
        (yield* repository.getByIdentity({
          threadId: secondThreadId,
          interactionKind: "userInput",
          requestId,
        }))._tag,
        "Some",
      );
    }),
  );

  it.effect("reads only questions while historical approval rows wait for table removal", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionPendingInteractionRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("thread-historical-pending");
      yield* sql`INSERT INTO projection_pending_interactions
        (interaction_kind, request_id, thread_id, status, created_at)
        VALUES ('approval', 'same-request', ${threadId}, 'pending', '2026-10-11T00:00:00.000Z')`;
      assert.deepStrictEqual(yield* repository.listByThreadId({ threadId }), []);
      assert.isFalse((yield* repository.listUnresolved()).some((row) => row.threadId === threadId));
      assert.strictEqual(
        (yield* repository.getByIdentity({
          threadId,
          interactionKind: "userInput",
          requestId: "same-request",
        }))._tag,
        "None",
      );
      const question = {
        threadId,
        interactionKind: "userInput" as const,
        requestId: "same-request",
        turnId: null,
        lifecycleGeneration: "generation",
        status: "pending" as const,
        responseCommandId: null,
        responseRequestedAt: null,
        createdAt: "2026-10-11T00:00:00.000Z",
        resolvedAt: null,
      };
      yield* repository.upsert(question);
      assert.deepStrictEqual(yield* repository.listByThreadId({ threadId }), [question]);
      assert.deepStrictEqual(
        (yield* repository.listUnresolved()).filter((row) => row.threadId === threadId),
        [question],
      );
      const [row] = yield* sql<{ count: number }>`SELECT COUNT(*) AS count
        FROM projection_pending_interactions WHERE thread_id = ${threadId}`;
      assert.strictEqual(row!.count, 2);
    }),
  );

  it.effect("lists every nonterminal interaction for process-boundary cleanup", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionPendingInteractionRepository;
      const threadId = ThreadId.makeUnsafe("thread-unresolved-interactions");
      for (const [index, status] of (
        ["pending", "retryable", "responding", "uncertain", "confirmed"] as const
      ).entries()) {
        yield* repository.upsert({
          interactionKind: "userInput",
          requestId: `request-${status}`,
          threadId,
          turnId: null,
          lifecycleGeneration: "generation-before-restart",
          status,
          responseCommandId: null,
          responseRequestedAt: null,
          createdAt: `2026-07-14T12:20:0${index}.000Z`,
          resolvedAt: status === "confirmed" ? "2026-07-14T12:21:00.000Z" : null,
        });
      }

      assert.deepStrictEqual(
        (yield* repository.listUnresolved())
          .filter((row) => row.threadId === threadId)
          .map((row) => row.status),
        ["pending", "retryable", "responding", "uncertain"],
      );
    }),
  );
});
