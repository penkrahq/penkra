import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import migration from "./179_RemoveFolderPinning.ts";

it.effect("drops folder pinning, preserves folder metadata, and survives lineage replay", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 178 });
    yield* sql`INSERT INTO projection_folders
      (folder_id, title, workspace_root, scripts_json, space_id, is_pinned, sidebar_sort_order, created_at, updated_at)
      VALUES ('folder', 'Folder', '/repo', '[]', 'penkra-personal', 1, 2, '2026-10-10T00:00:00.000Z', '2026-10-10T00:00:01.000Z')`;
    const read = sql`SELECT folder_id, title, workspace_root, space_id, sidebar_sort_order, created_at, updated_at FROM projection_folders WHERE folder_id = 'folder'`;
    const before = yield* read;
    yield* runMigrations();
    assert.deepStrictEqual(yield* read, before);
    const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_folders)`;
    assert.isFalse(columns.some((column) => column.name === "is_pinned"));
    const index = yield* sql<{
      sql: string;
    }>`SELECT sql FROM sqlite_master WHERE name = 'idx_projection_folders_sidebar_order'`;
    assert.isFalse(index[0]!.sql.includes("is_pinned"));
    yield* migration;
    assert.deepStrictEqual(yield* read, before);
    assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
