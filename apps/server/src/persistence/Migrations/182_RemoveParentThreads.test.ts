import { assert, it } from "@effect/vitest";
import { ThreadId } from "@penkra/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.effect(
  "keeps a former child as an ordinary folder thread, retaining its chat and unrelated indexes",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 181 });
      yield* sql`INSERT INTO projection_folders
      (folder_id, title, workspace_root, scripts_json, space_id, created_at, updated_at)
      VALUES ('folder', 'Folder', '/repo', '[]', 'penkra-personal', '2026-10-10T00:00:00.000Z', '2026-10-10T00:00:00.000Z')`;
      yield* sql`INSERT INTO threads
      (id, space_id, folder_id, title, provider, model, runtime_mode, state, created_by, parent_thread_id, created_at, updated_at)
      VALUES ('original', 'penkra-personal', 'folder', 'Original', 'codex', 'gpt-5.5', 'full-access', 'idle', 'user', NULL, '2026-10-10T00:00:00.000Z', '2026-10-10T00:00:00.000Z'),
      ('former-child', 'penkra-personal', 'folder', 'Retained chat', 'codex', 'gpt-5.5', 'full-access', 'idle', 'provider_native', 'original', '2026-10-10T00:00:00.000Z', '2026-10-10T00:00:00.000Z')`;
      yield* sql`INSERT INTO thread_items(thread_id, seq, source_id, kind, status, text, created_at, updated_at)
      VALUES ('former-child', 1, 'message', 'user', 'completed', 'Keep my chat', '2026-10-10T00:00:00.000Z', '2026-10-10T00:00:00.000Z')`;
      const readRows = sql`SELECT id, title, folder_id, created_by FROM threads ORDER BY id`;
      const readItems = sql`SELECT * FROM thread_items WHERE thread_id = 'former-child'`;
      const before = yield* readRows;
      const itemsBefore = yield* readItems;
      yield* runMigrations({ toMigrationInclusive: 182 });
      assert.deepStrictEqual(yield* readRows, before);
      assert.deepStrictEqual(yield* readItems, itemsBefore);
      const page = {
        threads: yield* sql<{
          id: string;
        }>`SELECT * FROM threads WHERE space_id='penkra-personal' AND folder_id='folder' ORDER BY id`,
      };
      assert.deepStrictEqual(
        page.threads.map((row) => row.id),
        [ThreadId.make("former-child"), ThreadId.make("original")],
      );
      assert.isFalse(page.threads.some((row) => "parentThreadId" in row));
      const columns = yield* sql<{ name: string }>`PRAGMA table_info(threads)`;
      assert.isFalse(columns.some((column) => column.name === "parent_thread_id"));
      const indexes = yield* sql<{
        name: string;
      }>`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'threads'`;
      assert.isTrue(indexes.some((index) => index.name === "idx_threads_sidebar_order"));
      assert.deepStrictEqual(yield* readRows, before);
      assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
