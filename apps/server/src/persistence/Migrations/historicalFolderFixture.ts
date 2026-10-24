import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

// Frozen pre-203 transcript fixture; current writers require columns absent here.
export const seedHistoricalThreadItem = (input: {
  threadId: string;
  sourceId: string;
  turnId: string | null;
  kind: string;
  status: string;
  text: string;
  data?: string | null;
  createdAt: string;
  updatedAt: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO thread_items
    (thread_id, seq, source_id, turn_id, kind, status, text, data, created_at, updated_at)
    VALUES (${input.threadId}, 1, ${input.sourceId}, ${input.turnId}, ${input.kind},
      ${input.status}, ${input.text}, ${input.data ?? null}, ${input.createdAt}, ${input.updatedAt})`;
  });

// Test fixture for the historical schema before migration 195 removes script metadata.
export const seedHistoricalFolderFixture = (input: {
  folderId: string;
  spaceId: string;
  title?: string;
  workspaceRoot?: string | null;
  createdAt?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const at = input.createdAt ?? "2026-10-09T00:00:00.000Z";
    yield* sql`INSERT INTO projection_folders
    (folder_id, title, space_id, workspace_root, scripts_json, created_at, updated_at)
    VALUES (${input.folderId}, ${input.title ?? "Fixture folder"}, ${input.spaceId}, ${input.workspaceRoot ?? null}, '[]', ${at}, ${at})`;
  });

export const seedHistoricalProjectFixture = (now: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_projects
    (project_id, kind, space_id, title, workspace_root, default_model_selection_json, scripts_json, created_at, updated_at)
    VALUES ('folder-removed-default', 'folder', 'space-migration-test', 'Folder', NULL,
      '{"provider":"cursor","model":"auto"}', '[]', ${now}, ${now})`;
  });

// Historical Claude startup fixture before the canonical/provider-table folds.
export const seedHistoricalClaudeNativeThread = (
  threadId: string,
  nativeId: string,
  folderId: string,
  at: string,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_threads (thread_id,folder_id,title,model_selection_json,created_at,updated_at) VALUES (${threadId},${folderId},'Chat','{"provider":"claudeAgent","model":"sonnet"}',${at},${at})`;
    yield* sql`INSERT INTO provider_native_state_generations (native_state_generation_id,owner_thread_id,harness_kind,adapter_schema_version,state_manifest_json,lifecycle,created_at) VALUES (${nativeId},${threadId},'claudeAgent','managed-native-state-v1','{}','active',${at})`;
  });
