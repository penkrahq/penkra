// FILE: 181_AgentThreadReadIndexes.ts
// Purpose: Index bounded folder and thread discovery pages.
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_threads_space_updated_live ON threads(space_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_folders_created_live ON projection_folders(deleted_at, archived_at, created_at, folder_id) WHERE deleted_at IS NULL AND archived_at IS NULL`;
});
