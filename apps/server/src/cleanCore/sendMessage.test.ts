import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { sendMessage } from "./sendMessage.ts";
import { createThread, makeThreadPublisher } from "./threadStore.ts";
import { applyProviderEvent } from "./providerStreamConsumer.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";

const withDb = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layerMemory()));

const baseThread = {
  id: "thread-1",
  spaceId: "space-1",
  title: "Hello",
  provider: "codex",
  model: "gpt-5.5",
  createdAt: "2026-10-09T00:00:00.000Z",
};

it.effect("delivers while idle and queues while running", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const publisher = makeThreadPublisher();
      yield* runMigrations();
      yield* createThread(baseThread);

      const delivered = yield* sendMessage(publisher, {
        threadId: "thread-1",
        message: { sourceId: "m1", text: "hi", at: "2026-10-09T00:00:01.000Z" },
        dispatchMode: "queue",
        supportsSteer: false,
      });
      assert.equal(delivered, "deliver");

      yield* applyProviderEvent(publisher, {
        type: "turn.started",
        threadId: "thread-1",
        turnId: "turn-1",
        at: "2026-10-09T00:00:02.000Z",
      });
      const queued = yield* sendMessage(publisher, {
        threadId: "thread-1",
        message: { sourceId: "m2", text: "later", at: "2026-10-09T00:00:03.000Z" },
        dispatchMode: "queue",
        supportsSteer: false,
      });
      assert.equal(queued, "queue");

      const items = yield* sql<{ readonly sourceId: string }>`
        SELECT source_id AS "sourceId" FROM thread_items WHERE thread_id = 'thread-1'
      `;
      assert.deepStrictEqual(items, [{ sourceId: "m1" }]);
      const queue = yield* sql<{ readonly queue: string }>`
        SELECT queue FROM threads WHERE id = 'thread-1'
      `;
      assert.deepStrictEqual(JSON.parse(queue[0]!.queue), [
        { sourceId: "m2", text: "later", at: "2026-10-09T00:00:03.000Z" },
      ]);
    }),
  ),
);

it.effect("steers when supported, otherwise interrupt-delivers", () =>
  withDb(
    Effect.gen(function* () {
      const publisher = makeThreadPublisher();
      yield* runMigrations();
      yield* createThread(baseThread);
      yield* applyProviderEvent(publisher, {
        type: "turn.started",
        threadId: "thread-1",
        turnId: "turn-1",
        at: "2026-10-09T00:00:01.000Z",
      });
      assert.equal(
        yield* sendMessage(publisher, {
          threadId: "thread-1",
          message: { sourceId: "s1", text: "now", at: "2026-10-09T00:00:02.000Z" },
          dispatchMode: "steer",
          supportsSteer: true,
        }),
        "steer",
      );
      assert.equal(
        yield* sendMessage(publisher, {
          threadId: "thread-1",
          message: { sourceId: "s2", text: "now", at: "2026-10-09T00:00:03.000Z" },
          dispatchMode: "steer",
          supportsSteer: false,
        }),
        "interrupt-deliver",
      );
    }),
  ),
);
