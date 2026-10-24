import { getNavigation } from "../../cleanCore/navigation";
import { assert, it } from "@effect/vitest";
import {} from "@penkra/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "../NodeSqliteClient";
import { runMigrations } from "../Migrations";
import removeNavigationEvents from "./196_RemoveNavigationEvents";
const at = "2026-10-12T00:00:00.000Z";
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 195 });
  yield* sql`INSERT INTO projection_spaces (space_id,name,icon,sort_order,created_at,updated_at) VALUES ('space','Saved','home',0,${at},${at})`;
  yield* sql`INSERT INTO projection_folders (folder_id,title,space_id,created_at,updated_at) VALUES ('folder','Saved folder','space',${at},${at})`;
  for (const kind of ["space", "folder"])
    yield* sql`INSERT INTO orchestration_events
    (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json)
    VALUES (${kind},${kind},${kind},0,${`${kind}.created`},${at},'user','{}','{}')`;
  yield* sql`INSERT INTO orchestration_events (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json) VALUES ('thread-event','thread','kept',0,'thread.session-stop-requested',${at},'user','{}','{}')`;
});
const db = NodeSqliteClient.layerMemory();
it.effect(
  "removes navigation history, preserves canonical state and replays remaining events",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed;
      const spaces = yield* sql`SELECT * FROM projection_spaces`;
      const folders = yield* sql`SELECT * FROM projection_folders`;
      const threadEvents =
        yield* sql`SELECT * FROM orchestration_events WHERE aggregate_kind='thread'`;
      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 200 }), [
        [196, "RemoveNavigationEvents"],
        [197, "SendRecoveryDraft"],
        [198, "IndexLatestTurn"],
        [199, "IndexOpenQuestions"],
        [200, "FailedSendPayload"],
      ]);
      assert.deepStrictEqual(yield* sql`SELECT * FROM projection_spaces`, spaces);
      assert.deepStrictEqual(yield* sql`SELECT * FROM projection_folders`, folders);
      assert.deepStrictEqual(yield* sql`SELECT * FROM orchestration_events`, threadEvents);
    }).pipe(Effect.provide(db)),
);
it.effect("rolls back the navigation journal deletion on failure", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seed;
    const legacy = JSON.stringify({ instanceId: "codex", model: "imported-project-model" });
    yield* sql`UPDATE projection_folders SET default_model_selection_json=${legacy} WHERE folder_id='folder'`;
    const foldersBefore = yield* sql`SELECT * FROM projection_folders`;
    const before = yield* sql`SELECT * FROM orchestration_events`;
    yield* Effect.flip(
      sql.withTransaction(
        removeNavigationEvents.pipe(Effect.andThen(Effect.fail(new Error("injected")))),
      ),
    );
    assert.deepStrictEqual(yield* sql`SELECT * FROM orchestration_events`, before);
    assert.deepStrictEqual(yield* sql`SELECT * FROM projection_folders`, foldersBefore);
  }).pipe(Effect.provide(db)),
);

it.effect("converts imported folder defaults once and exposes canonical navigation", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seed;
    const imported = JSON.stringify({
      instanceId: "codex",
      model: "imported-project-model",
      options: [{ id: "reasoningEffort", value: "medium" }],
    });
    yield* sql`UPDATE projection_folders SET default_model_selection_json=${imported} WHERE folder_id='folder'`;
    yield* runMigrations();
    const canonical = {
      provider: "codex",
      model: "imported-project-model",
      options: { reasoningEffort: "medium" },
    } as const;
    const [row] = yield* sql<{
      selection: string;
    }>`SELECT default_model_selection_json AS selection FROM projection_folders WHERE folder_id='folder'`;
    assert.deepStrictEqual(JSON.parse(row!.selection), canonical);
    assert.deepStrictEqual((yield* getNavigation).folders[0]?.defaultModelSelection, canonical);
  }).pipe(Effect.provide(db)),
);
it.effect("clears unconvertible folder defaults without aborting the migration", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seed;
    yield* sql`UPDATE projection_folders SET default_model_selection_json='{"provider":"codex","model":42}' WHERE folder_id='folder'`;
    yield* sql`INSERT INTO projection_folders (folder_id,title,space_id,default_model_selection_json,created_at,updated_at) VALUES ('malformed','Malformed','space','not json',${at},${at})`;
    yield* runMigrations();
    assert.deepStrictEqual(
      (yield* sql<{
        value: string | null;
      }>`SELECT default_model_selection_json AS value FROM projection_folders`).map(
        (row) => row.value,
      ),
      [null, null],
    );
    assert.isTrue(
      (yield* getNavigation).folders.every((row) => row.defaultModelSelection === null),
    );
  }).pipe(Effect.provide(db)),
);
