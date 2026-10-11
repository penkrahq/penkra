import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import dropLoginJournals from "./190_DropConnectionLoginJournals.ts";

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 189 });
  const at = "2026-10-11T00:00:00.000Z";
  yield* sql`INSERT INTO provider_connection_logins (
    operation_id, connection_id, harness_kind, authentication_target_id,
    authentication_method_id, label, profile_ref, operation_state, created_at, updated_at
  ) VALUES ('stale-login', 'candidate', 'codex', 'openai-first-party', 'chatgpt',
    'Pending sign-in', 'provider-profile:pending', 'awaiting-user', ${at}, ${at})`;
  yield* sql`INSERT INTO provider_connection_operations (
    operation_id, connection_id, operation_kind, operation_state, payload_json, created_at, updated_at
  ) VALUES ('stale-operation', 'candidate', 'create-static', 'pending', '{}', ${at}, ${at})`;
  yield* sql`INSERT INTO provider_credential_profiles (
    profile_ref, harness_kind, authentication_target_id, authentication_method_id,
    lifecycle, connection_id, login_operation_id, created_at, updated_at, retired_at
  ) VALUES ('provider-profile:pending', 'codex', 'openai-first-party', 'chatgpt',
    'staging', NULL, 'stale-login', ${at}, ${at}, NULL)`;
  yield* sql`INSERT INTO provider_connections (
    connection_id, harness_kind, authentication_target_id, authentication_method_id,
    label, credential_ref, profile_ref, provider_identity_id, health_status,
    lifecycle, termination_reason, terminated_at, created_at, updated_at
  ) VALUES ('existing-account', 'codex', 'openai-first-party', 'chatgpt',
    'Existing account', NULL, 'provider-profile:existing-account',
    'operator@example.test', 'ready', 'active', NULL, NULL, ${at}, ${at})`;
});

it.effect("drops both unused journals and preserves durable credentials and Connections", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seed;
    const profiles = yield* sql`SELECT * FROM provider_credential_profiles ORDER BY profile_ref`;
    const connections = yield* sql`SELECT * FROM provider_connections ORDER BY connection_id`;
    assert.deepStrictEqual(yield* runMigrations(), [[190, "DropConnectionLoginJournals"]]);
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM provider_credential_profiles ORDER BY profile_ref`,
      profiles,
    );
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM provider_connections ORDER BY connection_id`,
      connections,
    );
    assert.deepStrictEqual(
      yield* sql`SELECT name FROM sqlite_master WHERE
      sql LIKE '%provider_connection_logins%' OR sql LIKE '%provider_connection_operations%'`,
      [],
    );
    assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("restores journal rows and schema when the migration transaction fails", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seed;
    const schema = yield* sql`SELECT * FROM sqlite_master ORDER BY type, name`;
    const logins = yield* sql`SELECT * FROM provider_connection_logins ORDER BY operation_id`;
    const operations =
      yield* sql`SELECT * FROM provider_connection_operations ORDER BY operation_id`;
    const error = yield* Effect.flip(
      sql.withTransaction(
        dropLoginJournals.pipe(Effect.andThen(Effect.fail(new Error("injected failure")))),
      ),
    );
    assert.equal(error.message, "injected failure");
    assert.deepStrictEqual(yield* sql`SELECT * FROM sqlite_master ORDER BY type, name`, schema);
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM provider_connection_logins ORDER BY operation_id`,
      logins,
    );
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM provider_connection_operations ORDER BY operation_id`,
      operations,
    );
    assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
