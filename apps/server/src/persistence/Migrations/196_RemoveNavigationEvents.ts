// Canonical navigation rows hold the state; retired navigation journals are removed, not filtered.
import { ModelSelection } from "@penkra/contracts";
import { normalizePersistedModelSelection } from "../modelSelectionCompatibility";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    folderId: string;
    selection: string;
  }>`SELECT folder_id AS "folderId", default_model_selection_json AS selection FROM projection_folders WHERE default_model_selection_json IS NOT NULL`;
  for (const row of rows) {
    const selection = yield* Effect.try({
      try: () => normalizePersistedModelSelection(JSON.parse(row.selection)),
      catch: (cause) => new Error("Invalid folder default selection", { cause }),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ModelSelection)),
      Effect.catch(() => Effect.succeed(null)),
    );
    yield* sql`UPDATE projection_folders SET default_model_selection_json=${selection === null ? null : JSON.stringify(selection)} WHERE folder_id=${row.folderId}`;
  }
  yield* sql`DELETE FROM orchestration_events WHERE aggregate_kind IN ('space', 'folder')`;
});
