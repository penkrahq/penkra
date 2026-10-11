import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { createThread, upsertThreadItem } from "../../cleanCore/threadStore.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import dropUnusedBookkeeping from "./188_DropUnusedBookkeeping.ts";

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 187 });
  const at = "2026-10-11T00:00:00.000Z";
  yield* sql`INSERT INTO projection_folders (
    folder_id, space_id, title, scripts_json, created_at, updated_at
  ) VALUES ('bookkeeping-folder', 'penkra-personal', 'Folder', '[]', ${at}, ${at})`;
  yield* createThread({
    id: "bookkeeping-thread",
    spaceId: "penkra-personal",
    folderId: "bookkeeping-folder",
    title: "Keep this thread",
    provider: "claudeAgent",
    model: "claude-sonnet-4-6",
    runtimeMode: "full-access",
    createdBy: "user",
    createdAt: at,
  });
  yield* sql`UPDATE threads SET provider_session_id = 'existing-session',
    native_state_id = 'existing-native' WHERE id = 'bookkeeping-thread'`;
  yield* upsertThreadItem({
    threadId: "bookkeeping-thread",
    sourceId: "existing-message",
    turnId: null,
    kind: "text",
    status: "done",
    text: "Keep this transcript",
    data: null,
    createdAt: at,
    updatedAt: at,
  });
  yield* sql`INSERT INTO provider_native_fork_operations (
    operation_id, command_id, source_thread_id, target_thread_id, operation_state,
    source_state_revision, source_binding_revision, target_native_state_generation_id,
    selection_json, command_json, created_at, updated_at
  ) VALUES ('obsolete-fork', 'obsolete-command', 'bookkeeping-thread', 'removed-target',
    'pending', 0, 0, 'removed-native', '{}', '{}', ${at}, ${at})`;
  yield* sql`INSERT INTO git_thread_environment_operations (
    command_id, thread_id, input_json, phase, created_at, updated_at
  ) VALUES ('obsolete-git', 'bookkeeping-thread', '{}', 'pending', ${at}, ${at})`;
  yield* sql`INSERT INTO project_pull_request_pins (
    project_id, repository_key, pull_request_number
  ) VALUES ('bookkeeping-folder', 'penkrahq/penkra', 1)`;
});

it.effect("drops unused tables and their schema objects without changing chats or containers", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seed;
    const threads = yield* sql`SELECT * FROM threads ORDER BY id`;
    const items = yield* sql`SELECT * FROM thread_items ORDER BY thread_id, seq`;
    const folders = yield* sql`SELECT * FROM projection_folders ORDER BY folder_id`;
    const spaces = yield* sql`SELECT * FROM projection_spaces ORDER BY space_id`;
    assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 188 }), [
      [188, "DropUnusedBookkeeping"],
    ]);
    assert.deepStrictEqual(yield* sql`SELECT * FROM threads ORDER BY id`, threads);
    assert.deepStrictEqual(yield* sql`SELECT * FROM thread_items ORDER BY thread_id, seq`, items);
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM projection_folders ORDER BY folder_id`,
      folders,
    );
    assert.deepStrictEqual(yield* sql`SELECT * FROM projection_spaces ORDER BY space_id`, spaces);
    assert.deepStrictEqual(
      yield* sql`SELECT name FROM sqlite_master WHERE
        sql LIKE '%provider_native_fork_operations%' OR
        sql LIKE '%git_thread_environment_operations%' OR
        sql LIKE '%project_pull_request_pins%'`,
      [],
    );
    assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
    yield* runMigrations();
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("rolls the table drops back when a migration transaction fails", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seed;
    const schema = yield* sql`SELECT * FROM sqlite_master ORDER BY type, name`;
    const error = yield* Effect.flip(
      sql.withTransaction(
        dropUnusedBookkeeping.pipe(Effect.andThen(Effect.fail(new Error("injected failure")))),
      ),
    );
    assert.equal(error.message, "injected failure");
    assert.deepStrictEqual(yield* sql`SELECT * FROM sqlite_master ORDER BY type, name`, schema);
    assert.lengthOf(yield* sql`SELECT * FROM provider_native_fork_operations`, 1);
    assert.lengthOf(yield* sql`SELECT * FROM git_thread_environment_operations`, 1);
    assert.lengthOf(yield* sql`SELECT * FROM project_pull_request_pins`, 1);
    assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
