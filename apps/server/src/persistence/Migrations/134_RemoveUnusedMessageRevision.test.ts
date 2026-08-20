import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("134_RemoveUnusedMessageRevision", (it) => {
  it.effect("removes the unused column and its delete trigger from upgraded databases", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 127 });

      // Reproduce the schema shipped by the original migration 128 so the forward
      // migration remains covered after fresh installs stop creating it.
      yield* sql`
        ALTER TABLE projection_threads
        ADD COLUMN messages_revision INTEGER NOT NULL DEFAULT 0
      `;
      yield* sql`
        CREATE TRIGGER projection_thread_messages_revision_delete
        AFTER DELETE ON projection_thread_messages
        BEGIN
          UPDATE projection_threads
          SET messages_revision = messages_revision + 1
          WHERE thread_id = OLD.thread_id;
        END
      `;

      yield* runMigrations({ toMigrationInclusive: 134 });

      const columns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('projection_threads')
        WHERE name = 'messages_revision'
      `;
      const triggers = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'trigger' AND name = 'projection_thread_messages_revision_delete'
      `;
      assert.deepStrictEqual(columns, []);
      assert.deepStrictEqual(triggers, []);
    }),
  );
});
