import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import dropJournals from "./191_DropNativeSwitchJournals.ts";

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 190 });
  const at = "2026-10-11T00:00:00.000Z";
  yield* sql`INSERT INTO projection_folders (folder_id,space_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('journal-folder','penkra-personal','Journal',NULL,'[]',${at},${at})`;
  yield* sql`INSERT INTO threads (id,space_id,folder_id,title,provider,model,runtime_mode,state,native_state_id,provider_session_id,created_by,created_at,updated_at) VALUES ('journal-thread','penkra-personal','journal-folder','Journal','claudeAgent','claude-sonnet-5','full-access','idle','native','session','user',${at},${at})`;
  yield* sql`INSERT INTO provider_native_state_deletions (native_state_generation_id,owner_thread_id,deletion_state,failure_reason,created_at,updated_at) VALUES ('retired-native','old-thread','pending',NULL,${at},${at})`;
});

it.effect(
  "drops unused native-state journals while preserving canonical rows and foreign keys",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed;
      const before = yield* sql`SELECT * FROM threads ORDER BY id`;
      assert.deepStrictEqual(yield* runMigrations(), [
        [191, "DropNativeSwitchJournals"],
        [192, "DropProviderDeliveryRepairs"],
        [193, "DropRuntimeGlobalConsumerLedger"],
        [194, "RemoveApprovalDecisionColumn"],
        [195, "RemoveFolderScripts"],
      ]);
      assert.deepStrictEqual(yield* sql`SELECT * FROM threads ORDER BY id`, before);
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE sql LIKE '%provider_thread_switch_operations%' OR sql LIKE '%provider_native_state_deletions%'`,
        [],
      );
      assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("restores the journals, deletion entries and trigger on transaction failure", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seed;
    const schema = yield* sql`SELECT * FROM sqlite_master ORDER BY type,name`;
    const rows = yield* sql`SELECT * FROM provider_native_state_deletions`;
    const error = yield* Effect.flip(
      sql.withTransaction(
        dropJournals.pipe(Effect.andThen(Effect.fail(new Error("injected failure")))),
      ),
    );
    assert.strictEqual(error.message, "injected failure");
    assert.deepStrictEqual(yield* sql`SELECT * FROM sqlite_master ORDER BY type,name`, schema);
    assert.deepStrictEqual(yield* sql`SELECT * FROM provider_native_state_deletions`, rows);
    assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
