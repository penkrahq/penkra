import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations";
import * as NodeSqliteClient from "../NodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("136_RemoveProfileStats", (it) => {
  it.effect("drops the unreachable profile-stat archive and query indexes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const objects = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_schema
        WHERE name LIKE 'profile_stats_deleted_%'
           OR name IN (
             'idx_projection_thread_messages_profile_prompt_activity',
             'idx_orchestration_events_profile_turn_events',
             'idx_projection_thread_activities_profile_token_activity'
           )
      `;
      assert.deepEqual(objects, []);
    }),
  );
});
