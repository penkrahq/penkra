import { seedHistoricalFolderFixture } from "./historicalFolderFixture.ts";
import { assert, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.effect(
  "preserves bindings, drops orphan harness rows, and enforces the canonical foreign key",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 176 });
      yield* seedHistoricalFolderFixture({ folderId: "folder", spaceId: "space" });
      const now = "2026-10-10T00:00:00.000Z";
      yield* sql`INSERT INTO projection_threads (thread_id, folder_id, title, created_at, updated_at)
      VALUES ('retained', 'folder', 'Retained', ${now}, ${now}), ('orphan', 'folder', 'Orphan', ${now}, ${now})`;
      yield* sql`INSERT INTO threads (id, space_id, folder_id, title, provider, model, runtime_mode, state, created_by, created_at, updated_at)
      VALUES ('retained', 'space', 'folder', 'Retained', 'codex', 'gpt-5.5', 'full-access', 'idle', 'user', ${now}, ${now})`;
      yield* sql`INSERT INTO provider_native_state_generations
      (native_state_generation_id, harness_kind, adapter_schema_version, state_manifest_json, lifecycle, created_at, owner_thread_id)
      VALUES ('generation', 'codex', '1', '{}', 'active', ${now}, 'retained')`;
      yield* sql`INSERT INTO provider_installations
      (installation_id, harness_kind, version, platform, architecture, executable_path, artifact_source, artifact_url, artifact_sha256, adapter_version, protocol_version, lifecycle, installed_at, activated_at)
      VALUES ('installation', 'codex', '1', 'darwin', 'arm64', '/managed/codex', 'test', 'https://example.invalid/codex', ${"a".repeat(64)}, '1', 'v1', 'active', ${now}, ${now})`;
      for (const id of ["retained", "orphan"]) {
        yield* sql`INSERT INTO thread_harness_states
        (thread_id, harness_kind, native_state_generation_id, provider_session_id, native_state_locator_json, state_revision, created_at, updated_at)
        VALUES (${id}, 'codex', 'generation', 'session', '{}', 7, ${now}, ${now})`;
        yield* sql`INSERT INTO thread_runtime_bindings
        (thread_id, installation_id, binding_revision, created_at, updated_at)
        VALUES (${id}, 'installation', 3, ${now}, ${now})`;
      }
      yield* sql`INSERT INTO notices (notice_id, thread_id, kind, tone, summary, detail_json, created_at)
      VALUES ('retained-notice', 'retained', 'runtime.warning', 'warning', 'Keep', '{}', ${now}),
        ('orphan-notice', 'orphan', 'runtime.warning', 'warning', 'Drop', '{}', ${now})`;
      const noticeBefore = yield* sql`SELECT * FROM notices WHERE thread_id = 'retained'`;
      const before = yield* sql`SELECT * FROM thread_harness_states WHERE thread_id = 'retained'`;
      const bindingBefore =
        yield* sql`SELECT * FROM thread_runtime_bindings WHERE thread_id = 'retained'`;
      yield* runMigrations({ toMigrationInclusive: 177 });
      assert.deepStrictEqual(yield* sql`SELECT * FROM thread_harness_states`, before);
      assert.deepStrictEqual(yield* sql`SELECT * FROM thread_runtime_bindings`, bindingBefore);
      assert.deepStrictEqual(yield* sql`SELECT * FROM notices`, noticeBefore);
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name <> 'projection_threads' AND sql LIKE '%projection_threads%'`,
        [],
      );
      const keys = yield* sql.unsafe<{
        table: string;
        from: string;
        to: string;
        on_delete: string;
      }>("PRAGMA foreign_key_list(thread_harness_states)");
      assert.isTrue(
        keys.some(
          (key) =>
            key.table === "threads" &&
            key.from === "thread_id" &&
            key.to === "id" &&
            key.on_delete === "CASCADE",
        ),
      );
      const invalidRevision = yield* Effect.exit(
        sql`UPDATE thread_harness_states SET state_revision = 9 WHERE thread_id = 'retained'`,
      );
      assert.isTrue(Exit.isFailure(invalidRevision));
      yield* sql`DELETE FROM threads WHERE id = 'retained'`;
      assert.deepStrictEqual(yield* sql`SELECT * FROM thread_harness_states`, []);
      assert.deepStrictEqual(yield* sql`SELECT * FROM thread_runtime_bindings`, []);
      assert.deepStrictEqual(yield* sql`SELECT * FROM notices`, []);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
