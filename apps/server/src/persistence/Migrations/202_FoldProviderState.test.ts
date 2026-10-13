// Purpose: Prove the owner correction and transactional provider-table fold.
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { runMigrations } from "../Migrations.ts";
import fold from "./202_FoldProviderState.ts";
import { seedThreadFolderFixture } from "../../cleanCore/threadFixtures.ts";
const at = "2026-10-13T00:00:00.000Z";
const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 201 });
  yield* seedThreadFolderFixture("folder", "space");
  for (const id of ["owner", "composer"])
    yield* sql`INSERT INTO provider_connections (connection_id,harness_kind,authentication_target_id,authentication_method_id,label,profile_ref,health_status,lifecycle,created_at,updated_at) VALUES (${id},'claudeAgent','anthropic-first-party','claude-account',${id},${"profile:" + id},'ready','active',${at},${at})`;
  yield* sql`INSERT INTO provider_installations (installation_id,harness_kind,version,platform,architecture,executable_path,artifact_source,artifact_url,artifact_sha256,adapter_version,protocol_version,lifecycle,installed_at,activated_at) VALUES ('installation','claudeAgent','1','test','test','/test/claude','test','test://claude',${"a".repeat(64)},'1','1','active',${at},${at})`;
  yield* sql`INSERT INTO threads (id,space_id,folder_id,title,provider,connection_id,model,runtime_mode,native_state_id,created_by,created_at,updated_at) VALUES ('thread','space','folder','Thread','claudeAgent','composer','sonnet','full-access','native','user',${at},${at})`;
  yield* sql`INSERT INTO provider_native_state_generations (native_state_generation_id,owner_thread_id,harness_kind,adapter_schema_version,state_manifest_json,lifecycle,created_at) VALUES ('native','thread','claudeAgent','1','{}','active',${at})`;
  yield* sql`INSERT INTO thread_harness_states (thread_id,harness_kind,native_state_generation_id,provider_session_id,native_state_locator_json,created_at,updated_at) VALUES ('thread','claudeAgent','native','exact-session','{}',${at},${at})`;
  yield* sql`INSERT INTO thread_runtime_bindings (thread_id,connection_id,installation_id,created_at,updated_at) VALUES ('thread','owner','installation',${at},${at})`;
});
it.effect("uses the native owner and preserves identities, with rollback on failure", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* setup;
    const before = yield* sql`SELECT * FROM threads`;
    const result = yield* Effect.exit(
      sql.withTransaction(fold.pipe(Effect.andThen(Effect.fail(new Error("injected"))))),
    );
    assert.equal(result._tag, "Failure");
    assert.deepStrictEqual(yield* sql`SELECT * FROM threads`, before);
    assert.equal((yield* sql`SELECT * FROM thread_runtime_bindings`).length, 1);
    yield* runMigrations();
    assert.deepStrictEqual(
      yield* sql`SELECT id,connection_id,provider_session_id,native_state_id FROM threads`,
      [
        {
          id: "thread",
          connection_id: "owner",
          provider_session_id: "exact-session",
          native_state_id: "native",
        },
      ],
    );
    assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
    for (const name of [
      "thread_runtime_bindings",
      "thread_harness_states",
      "provider_session_runtime",
      "provider_native_state_generations",
    ])
      assert.equal(
        (yield* sql`SELECT name FROM sqlite_master WHERE type='table' AND name=${name}`).length,
        0,
      );
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
