import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("164_ThreadDecks", (it) => {
  it.effect("backfills stable singleton decks without rewriting historical events", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 163 });
      const timestamp = "2026-09-16T12:00:00.000Z";
      yield* sql`
        INSERT INTO projection_spaces (
          space_id, name, icon, sort_order, created_at, updated_at
        ) VALUES ('space-1', 'Space', 'bag', 0, ${timestamp}, ${timestamp})
      `;
      yield* sql`
        INSERT INTO projection_folders (
          folder_id, kind, space_id, title, workspace_root,
          default_model_selection_json, scripts_json, created_at, updated_at
        ) VALUES (
          'folder-1', 'folder', 'space-1', 'Folder', '/workspace',
          NULL, '[]', ${timestamp}, ${timestamp}
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, folder_id, title, model_selection_json, runtime_mode,
          sidebar_sort_order, created_at, updated_at
        ) VALUES (
          'thread-1', 'folder-1', 'Thread',
          '{"provider":"codex","model":"gpt-5.6-sol"}', 'full-access',
          7, ${timestamp}, ${timestamp}
        )
      `;
      const legacyPayload = JSON.stringify({
        threadId: "thread-1",
        folderId: "folder-1",
        title: "Thread",
      });
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json
        ) VALUES (
          'event-thread-1', 'thread', 'thread-1', 0, 'thread.created',
          ${timestamp}, 'client', ${legacyPayload},
          '{"persistedEventSchemaVersion":1}'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 164 });

      const threads = yield* sql<{
        readonly deckId: string;
        readonly deckSortOrder: number;
        readonly sidebarSortOrder: number;
      }>`
        SELECT deck_id AS "deckId", deck_sort_order AS "deckSortOrder",
               sidebar_sort_order AS "sidebarSortOrder"
        FROM projection_threads WHERE thread_id = 'thread-1'
      `;
      assert.deepEqual(threads, [
        { deckId: "deck:thread-1", deckSortOrder: 0, sidebarSortOrder: 7 },
      ]);
      const decks = yield* sql<{
        readonly deckId: string;
        readonly spaceId: string;
      }>`
        SELECT deck_id AS "deckId", space_id AS "spaceId"
        FROM projection_thread_decks
      `;
      assert.deepEqual(decks, [{ deckId: "deck:thread-1", spaceId: "space-1" }]);
      const events = yield* sql<{ readonly payloadJson: string }>`
        SELECT payload_json AS "payloadJson" FROM orchestration_events
        WHERE event_id = 'event-thread-1'
      `;
      assert.strictEqual(events[0]?.payloadJson, legacyPayload);
    }),
  );
});
