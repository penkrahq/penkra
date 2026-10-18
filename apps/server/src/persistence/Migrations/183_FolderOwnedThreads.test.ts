import { assert, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.effect(
  "preserves threads and dependent rows, removes overrides and decks, and requires an existing folder",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA foreign_keys = ON`;
      yield* runMigrations({ toMigrationInclusive: 182 });
      const now = "2026-10-10T00:00:00.000Z";
      yield* sql`INSERT INTO projection_folders (folder_id, title, workspace_root, scripts_json, space_id, created_at, updated_at)
    VALUES ('folder', 'Folder', '/repo', '[]', 'penkra-personal', ${now}, ${now})`;
      yield* sql`INSERT INTO projection_thread_decks (deck_id, space_id, created_at, updated_at)
    VALUES ('old-deck', 'penkra-personal', ${now}, ${now})`;
      yield* sql`INSERT INTO threads (id, space_id, folder_id, title, provider, model, runtime_mode, state, created_by,
    working_directory, deck_id, deck_sort_order, created_at, updated_at)
    VALUES ('override', 'penkra-personal', 'folder', 'Override', 'codex', 'gpt-5.5', 'full-access', 'idle', 'user', '/old', NULL, 0, ${now}, ${now}),
    ('member', 'penkra-personal', 'folder', 'Member', 'codex', 'gpt-5.5', 'full-access', 'idle', 'user', NULL, 'old-deck', 2, ${now}, ${now})`;
      yield* sql`INSERT INTO provider_native_state_generations
    (native_state_generation_id, harness_kind, adapter_schema_version, state_manifest_json, lifecycle, created_at, owner_thread_id)
    VALUES ('generation', 'codex', '1', '{}', 'active', ${now}, 'override')`;
      yield* sql`INSERT INTO provider_installations
    (installation_id, harness_kind, version, platform, architecture, executable_path, artifact_source, artifact_url, artifact_sha256, adapter_version, protocol_version, lifecycle, installed_at, activated_at)
    VALUES ('installation', 'codex', '1', 'darwin', 'arm64', '/managed/codex', 'test', 'https://example.invalid/codex', ${"a".repeat(64)}, '1', 'v1', 'active', ${now}, ${now})`;
      yield* sql`INSERT INTO thread_harness_states
    (thread_id, harness_kind, native_state_generation_id, provider_session_id, native_state_locator_json, state_revision, created_at, updated_at)
    VALUES ('override', 'codex', 'generation', 'session', '{}', 7, ${now}, ${now})`;
      yield* sql`INSERT INTO thread_runtime_bindings
    (thread_id, installation_id, binding_revision, created_at, updated_at)
    VALUES ('override', 'installation', 3, ${now}, ${now})`;
      yield* sql`INSERT INTO notices (notice_id, thread_id, kind, tone, summary, detail_json, created_at)
    VALUES ('notice', 'override', 'runtime.warning', 'warning', 'Keep notice', '{}', ${now})`;
      yield* sql`INSERT INTO thread_items (thread_id, seq, source_id, kind, status, text, created_at, updated_at)
    VALUES ('override', 1, 'message', 'user', 'sent', 'Keep chat', ${now}, ${now})`;
      const readThreads = sql`SELECT id, space_id, folder_id, title, provider, model, runtime_mode, state, created_by, created_at, updated_at FROM threads ORDER BY id`;
      const before = yield* readThreads;
      const items = yield* sql`SELECT rowid, * FROM thread_items`;
      const harness = yield* sql`SELECT * FROM thread_harness_states`;
      const bindings = yield* sql`SELECT * FROM thread_runtime_bindings`;
      const notices = yield* sql`SELECT * FROM notices`;
      const objects = yield* sql`SELECT type, name, sql FROM sqlite_master
    WHERE tbl_name IN ('thread_harness_states', 'thread_runtime_bindings', 'notices') AND sql IS NOT NULL ORDER BY name`;
      yield* runMigrations({ toMigrationInclusive: 183 });
      assert.deepStrictEqual(yield* readThreads, before);
      assert.deepStrictEqual(yield* sql`SELECT rowid, * FROM thread_items`, items);
      assert.deepStrictEqual(yield* sql`SELECT * FROM thread_harness_states`, harness);
      assert.deepStrictEqual(yield* sql`SELECT * FROM thread_runtime_bindings`, bindings);
      assert.deepStrictEqual(yield* sql`SELECT * FROM notices`, notices);
      const afterObjects = yield* sql<{
        type: string;
        name: string;
        sql: string;
      }>`SELECT type, name, sql FROM sqlite_master
    WHERE tbl_name IN ('thread_harness_states', 'thread_runtime_bindings', 'notices') AND sql IS NOT NULL ORDER BY name`;
      assert.deepStrictEqual(
        afterObjects.map((row) => ({ ...row, sql: row.sql.replace(/\s+/g, " ").trim() })),
        objects.map((row) => ({ ...row, sql: String(row.sql).replace(/\s+/g, " ").trim() })),
      );
      assert.deepStrictEqual(
        yield* sql`SELECT text FROM thread_items_search WHERE thread_items_search MATCH '"Keep"'`,
        [{ text: "Keep chat" }],
      );
      const columns = yield* sql<{ name: string; notnull: number }>`PRAGMA table_info(threads)`;
      for (const column of ["working_directory", "deck_id", "deck_sort_order"])
        assert.isFalse(columns.some((row) => row.name === column));
      assert.equal(columns.find((row) => row.name === "folder_id")!.notnull, 1);
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name IN ('projection_thread_decks', 'idx_threads_deck_order')`,
        [],
      );
      assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
      for (const folder of [null, "unknown"]) {
        const insert =
          yield* Effect.exit(sql`INSERT INTO threads (id, space_id, folder_id, title, provider, model, runtime_mode, state, created_by, created_at, updated_at)
      VALUES ('invalid', 'penkra-personal', ${folder}, 'Invalid', 'codex', 'gpt-5.5', 'full-access', 'idle', 'user', ${now}, ${now})`);
        assert.isTrue(Exit.isFailure(insert));
      }
      const invalidRevision = yield* Effect.exit(
        sql`UPDATE thread_harness_states SET state_revision = 9 WHERE thread_id = 'override'`,
      );
      assert.isTrue(Exit.isFailure(invalidRevision));
      yield* sql`DELETE FROM threads WHERE id = 'override'`;
      assert.deepStrictEqual(yield* sql`SELECT * FROM thread_harness_states`, []);
      assert.deepStrictEqual(yield* sql`SELECT * FROM thread_runtime_bindings`, []);
      assert.deepStrictEqual(yield* sql`SELECT * FROM notices`, []);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("adopts only a folder's one agreed live thread directory", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 182 });
    const now = "2026-10-10T00:00:00.000Z";
    for (const [id, root] of [
      ["adopt", null],
      ["existing", "/chosen"],
      ["conflict", null],
      ["empty", null],
    ] as const) {
      yield* sql`INSERT INTO projection_folders (folder_id, title, workspace_root, scripts_json, space_id, created_at, updated_at)
        VALUES (${id}, ${id}, ${root}, '[]', 'penkra-personal', ${now}, ${now})`;
    }
    for (const [id, folder, directory, deleted] of [
      ["adopt-one", "adopt", "/missing-on-disk", null],
      ["adopt-two", "adopt", "/missing-on-disk", null],
      ["adopt-null", "adopt", null, null],
      ["adopt-deleted", "adopt", "/ignored", now],
      ["existing-one", "existing", "/other", null],
      ["conflict-one", "conflict", "/one", null],
      ["conflict-two", "conflict", "/two", null],
      ["empty-one", "empty", null, null],
    ] as const) {
      yield* sql`INSERT INTO threads (id, space_id, folder_id, title, provider, model, runtime_mode, state, created_by,
        working_directory, deleted_at, created_at, updated_at)
        VALUES (${id}, 'penkra-personal', ${folder}, ${id}, 'codex', 'gpt-5.5', 'full-access', 'idle', 'user',
          ${directory}, ${deleted}, ${now}, ${now})`;
    }
    const before = yield* sql`SELECT id FROM threads ORDER BY id`;
    yield* runMigrations({ toMigrationInclusive: 183 });
    assert.deepStrictEqual(
      yield* sql`SELECT folder_id, workspace_root FROM projection_folders
      WHERE folder_id IN ('adopt', 'existing', 'conflict', 'empty') ORDER BY folder_id`,
      [
        { folder_id: "adopt", workspace_root: "/missing-on-disk" },
        { folder_id: "conflict", workspace_root: null },
        { folder_id: "empty", workspace_root: null },
        { folder_id: "existing", workspace_root: "/chosen" },
      ],
    );
    assert.deepStrictEqual(yield* sql`SELECT id FROM threads ORDER BY id`, before);
    assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
