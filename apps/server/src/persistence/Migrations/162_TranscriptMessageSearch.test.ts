import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("162_TranscriptMessageSearch", (it) => {
  it.effect("backfills and transactionally follows message projection changes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 161 });
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        ) VALUES (
          'message-search', 'thread-search', 'user', 'Thread grouping discussion', 0,
          '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z'
        )
      `;
      yield* runMigrations();

      const inserted = yield* sql<{ readonly messageId: string }>`
        SELECT messages.message_id AS "messageId"
        FROM projection_thread_messages_search AS search
        JOIN projection_thread_messages AS messages ON messages.rowid = search.rowid
        WHERE projection_thread_messages_search MATCH '"grouping"'
      `;
      assert.deepEqual(inserted, [{ messageId: "message-search" }]);

      yield* sql`
        UPDATE projection_thread_messages
        SET text = 'Anchored context discussion'
        WHERE thread_id = 'thread-search' AND message_id = 'message-search'
      `;
      const updated = yield* sql<{ readonly messageId: string }>`
        SELECT messages.message_id AS "messageId"
        FROM projection_thread_messages_search AS search
        JOIN projection_thread_messages AS messages ON messages.rowid = search.rowid
        WHERE projection_thread_messages_search MATCH '"context"'
      `;
      assert.deepEqual(updated, [{ messageId: "message-search" }]);
      const stale = yield* sql`
        SELECT rowid
        FROM projection_thread_messages_search
        WHERE projection_thread_messages_search MATCH '"grouping"'
      `;
      assert.lengthOf(stale, 0);

      yield* sql`
        DELETE FROM projection_thread_messages
        WHERE thread_id = 'thread-search' AND message_id = 'message-search'
      `;
      const removed = yield* sql`
        SELECT rowid
        FROM projection_thread_messages_search
        WHERE projection_thread_messages_search MATCH '"context"'
      `;
      assert.lengthOf(removed, 0);
    }),
  );

  it.effect("uses the trigram virtual-table index for literal phrase lookup", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT rowid
        FROM projection_thread_messages_search
        WHERE projection_thread_messages_search MATCH '"thread grouping"'
      `;
      assert.isTrue(
        plan.some(({ detail }) => detail.includes("VIRTUAL TABLE INDEX")),
      );
    }),
  );

  it.effect("finds a rare literal in a five-thousand-message transcript through FTS", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql.unsafe(`
        WITH RECURSIVE numbers(value) AS (
          VALUES(1)
          UNION ALL
          SELECT value + 1 FROM numbers WHERE value < 5000
        )
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        )
        SELECT
          'bulk-message-' || value,
          'bulk-thread',
          CASE WHEN value % 2 = 0 THEN 'assistant' ELSE 'user' END,
          CASE WHEN value = 4999 THEN 'rare literal needle' ELSE 'ordinary transcript row' END,
          0,
          printf('2026-09-09T00:%02d:%02d.000Z', (value / 60) % 60, value % 60),
          printf('2026-09-09T00:%02d:%02d.000Z', (value / 60) % 60, value % 60)
        FROM numbers
      `);
      const matches = yield* sql<{ readonly messageId: string }>`
        SELECT messages.message_id AS "messageId"
        FROM projection_thread_messages_search AS search
        JOIN projection_thread_messages AS messages ON messages.rowid = search.rowid
        WHERE projection_thread_messages_search MATCH '"literal needle"'
      `;
      assert.deepEqual(matches, [{ messageId: "bulk-message-4999" }]);
    }),
  );
});
