import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "queued_turn_promotions", "action_kind"))) {
    yield* sql`
      ALTER TABLE queued_turn_promotions
      ADD COLUMN action_kind TEXT CHECK (action_kind IN ('cancel', 'steer'))
    `;
  }

  if (!(yield* columnExists(sql, "queued_turn_promotions", "action_event_id"))) {
    yield* sql`
      ALTER TABLE queued_turn_promotions
      ADD COLUMN action_event_id TEXT
    `;
  }
});
