import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("123_CanonicalMessageOffsets", (it) => {
  it.effect("backfills UTF-8 byte lengths rather than character counts", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 122 });
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, source, created_at, updated_at
        ) VALUES (
          'message-unicode', 'thread-unicode', 'assistant', 'δ🙂', 0, 'native',
          '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 123 });
      const rows = yield* sql<{ readonly appliedLen: number }>`
        SELECT applied_len AS "appliedLen"
        FROM projection_thread_messages
        WHERE thread_id = 'thread-unicode' AND message_id = 'message-unicode'
      `;
      assert.strictEqual(rows[0]?.appliedLen, Buffer.byteLength("δ🙂", "utf8"));
    }),
  );
});
