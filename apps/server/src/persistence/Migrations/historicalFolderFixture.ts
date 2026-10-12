import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

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
