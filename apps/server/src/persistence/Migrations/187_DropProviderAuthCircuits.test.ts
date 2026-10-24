import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.effect("drops persisted auth blocks while retaining their Connections", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 186 });
    yield* sql`
      INSERT INTO provider_connections (
        connection_id, harness_kind, authentication_target_id, authentication_method_id,
        label, profile_ref, created_at, updated_at
      ) VALUES ('auth-fixture', 'codex', 'openai-first-party', 'chatgpt',
        'Fixture', 'profile', '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z')
    `;
    yield* sql`
      INSERT INTO provider_auth_circuits (
        connection_id, kind, summary, detail, profile_ref, opened_at, next_probe_at, failure_count
      ) VALUES ('auth-fixture', 'reauth-required', 'Auth failed', '401', 'profile',
        '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:10.000Z', 1)
    `;
    const connections = yield* sql`SELECT * FROM provider_connections ORDER BY connection_id`;
    yield* runMigrations();
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM provider_connections ORDER BY connection_id`,
      connections,
    );
    assert.deepStrictEqual(
      yield* sql`SELECT name FROM sqlite_master WHERE name = 'provider_auth_circuits'`,
      [],
    );
    assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
