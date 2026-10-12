import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import removeScripts from "./195_RemoveFolderScripts.ts";

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 194 });
  yield* sql`INSERT INTO projection_folders
    (folder_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES ('folder', 'Keep', '/workspace', '[{"id":"dev","command":"npm run dev"}]',
      '2026-10-12T00:00:00.000Z', '2026-10-12T00:00:00.000Z')`;
});

it.effect("drops script metadata and preserves folder rows", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seed;
    const before =
      yield* sql`SELECT folder_id, title, workspace_root, created_at, updated_at FROM projection_folders`;
    assert.deepStrictEqual(yield* runMigrations(), [[195, "RemoveFolderScripts"]]);
    assert.deepStrictEqual(
      yield* sql`SELECT folder_id, title, workspace_root, created_at, updated_at FROM projection_folders`,
      before,
    );
    const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_folders)`;
    assert.isFalse(columns.some((column) => column.name === "scripts_json"));
    assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("rolls back the script column drop on failure", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seed;
    const before = yield* sql`SELECT * FROM projection_folders`;
    const error = yield* Effect.flip(
      sql.withTransaction(
        removeScripts.pipe(Effect.andThen(Effect.fail(new Error("injected failure")))),
      ),
    );
    assert.equal(error.message, "injected failure");
    assert.deepStrictEqual(yield* sql`SELECT * FROM projection_folders`, before);
    assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
