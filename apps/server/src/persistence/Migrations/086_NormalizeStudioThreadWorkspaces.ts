// Purpose: Repairs Studio threads that older web clients encoded as worktrees when the
//          composer "Use a folder" control selected an ordinary local directory.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "projection_threads", "working_directory"))) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN working_directory TEXT
    `;
  }

  const hasLegacyWorktreePath = yield* columnExists(sql, "projection_threads", "worktree_path");

  // Some imported lineages already removed worktree_path before this repair
  // replays. Keep both shapes valid so migration reconciliation stays lossless.
  if (hasLegacyWorktreePath) {
    yield* sql`
      UPDATE projection_threads
      SET working_directory = COALESCE(working_directory, worktree_path),
          env_mode = 'local',
          branch = NULL,
          worktree_path = NULL,
          associated_worktree_path = NULL,
          associated_worktree_branch = NULL,
          associated_worktree_ref = NULL,
          create_branch_flow_completed = 0
      WHERE project_id IN (
        SELECT project_id FROM projection_projects WHERE kind = 'studio' AND deleted_at IS NULL
      )
    `;
  }
});
