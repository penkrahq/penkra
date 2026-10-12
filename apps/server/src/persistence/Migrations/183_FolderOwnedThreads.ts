import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const readCounts = sql<{
    threads: number;
    items: number;
    harness: number;
    bindings: number;
    notices: number;
  }>`SELECT
    (SELECT COUNT(*) FROM threads) AS threads,
    (SELECT COUNT(*) FROM thread_items) AS items,
    (SELECT COUNT(*) FROM thread_harness_states) AS harness,
    (SELECT COUNT(*) FROM thread_runtime_bindings) AS bindings,
    (SELECT COUNT(*) FROM notices) AS notices`;
  const before = (yield* readCounts)[0]!;
  const removed = (yield* sql<{ workingDirectories: number; deckMemberships: number }>`
    SELECT COUNT(working_directory) AS workingDirectories,
      COUNT(deck_id) AS deckMemberships FROM threads`)[0]!;
  const folderRoots = (yield* sql<{ adoptedFolderRoots: number; conflictingFolders: number }>`
    SELECT COUNT(CASE WHEN paths = 1 THEN 1 END) AS adoptedFolderRoots,
      COUNT(CASE WHEN paths > 1 THEN 1 END) AS conflictingFolders
    FROM (
      SELECT COUNT(DISTINCT t.working_directory) AS paths
      FROM projection_folders f JOIN threads t ON t.folder_id = f.folder_id
      WHERE f.workspace_root IS NULL AND t.deleted_at IS NULL
        AND t.working_directory IS NOT NULL
      GROUP BY f.folder_id
    )`)[0]!;
  yield* sql`UPDATE projection_folders SET workspace_root = (
      SELECT MIN(t.working_directory) FROM threads t
      WHERE t.folder_id = projection_folders.folder_id
        AND t.deleted_at IS NULL AND t.working_directory IS NOT NULL
    ) WHERE workspace_root IS NULL AND (
      SELECT COUNT(DISTINCT t.working_directory) FROM threads t
      WHERE t.folder_id = projection_folders.folder_id
        AND t.deleted_at IS NULL AND t.working_directory IS NOT NULL
    ) = 1`;
  // Bindings depend on harness rows; save both before dropping either table.
  // thread_items has no foreign key to threads and stays in place with its FTS index.
  yield* sql`CREATE TEMP TABLE folder_owned_harness AS SELECT * FROM thread_harness_states`;
  yield* sql`CREATE TEMP TABLE folder_owned_bindings AS SELECT * FROM thread_runtime_bindings`;
  yield* sql`CREATE TEMP TABLE folder_owned_notices AS SELECT * FROM notices`;
  yield* sql`DROP TABLE thread_runtime_bindings`;
  yield* sql`DROP TABLE thread_harness_states`;
  yield* sql`DROP VIEW thread_activities_read`;
  yield* sql`DROP TABLE notices`;
  yield* sql`CREATE TABLE threads_new (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL,
    folder_id TEXT NOT NULL REFERENCES projection_folders(folder_id),
    title TEXT NOT NULL,
    provider TEXT NOT NULL,
    connection_id TEXT,
    model TEXT NOT NULL,
    model_options TEXT,
    runtime_mode TEXT NOT NULL,
    provider_session_id TEXT,
    native_state_id TEXT,
    state TEXT NOT NULL,
    active_turn_id TEXT,
    last_error TEXT,
    draft TEXT,
    draft_updated_at TEXT,
    queue TEXT NOT NULL DEFAULT '[]',
    created_by TEXT NOT NULL,
    created_by_thread_id TEXT,
    sidebar_sort_order INTEGER,
    last_activity_at TEXT,
    last_message_preview TEXT,
    last_user_message_at TEXT,
    last_visited_at TEXT,
    open_question_count INTEGER NOT NULL DEFAULT 0,
    archived_at TEXT,
    deleted_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`INSERT INTO threads_new SELECT
    id, space_id, folder_id, title, provider, connection_id, model, model_options,
    runtime_mode, provider_session_id, native_state_id, state, active_turn_id,
    last_error, draft, draft_updated_at, queue, created_by, created_by_thread_id,
    sidebar_sort_order, last_activity_at, last_message_preview, last_user_message_at,
    last_visited_at, open_question_count, archived_at, deleted_at, created_at, updated_at
    FROM threads`;
  yield* sql`DROP TABLE threads`;
  yield* sql`ALTER TABLE threads_new RENAME TO threads`;
  yield* sql`CREATE INDEX idx_threads_sidebar_order
    ON threads(space_id, folder_id, COALESCE(sidebar_sort_order, 0), created_at DESC, id)`;
  yield* sql`CREATE INDEX idx_threads_provider_live ON threads(provider, id) WHERE deleted_at IS NULL`;
  yield* sql`CREATE INDEX idx_threads_space_updated_live ON threads(space_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL`;
  yield* sql`CREATE TABLE thread_harness_states (
      thread_id TEXT PRIMARY KEY,
      harness_kind TEXT NOT NULL CHECK (length(trim(harness_kind)) > 0),
      native_state_generation_id TEXT NOT NULL,
      provider_session_id TEXT,
      native_state_locator_json TEXT NOT NULL CHECK (json_valid(native_state_locator_json)),
      last_verified_resume_at TEXT,
      state_revision INTEGER NOT NULL DEFAULT 0 CHECK (state_revision >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
      FOREIGN KEY (native_state_generation_id)
        REFERENCES provider_native_state_generations(native_state_generation_id) ON DELETE RESTRICT
    )`;
  yield* sql`CREATE TABLE thread_runtime_bindings (
      thread_id TEXT PRIMARY KEY,
      connection_id TEXT,
      installation_id TEXT NOT NULL,
      internal_provider_id TEXT,
      model_id TEXT,
      binding_revision INTEGER NOT NULL DEFAULT 0 CHECK (binding_revision >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (thread_id) REFERENCES thread_harness_states(thread_id) ON DELETE CASCADE,
      FOREIGN KEY (connection_id) REFERENCES provider_connections(connection_id) ON DELETE RESTRICT,
      FOREIGN KEY (installation_id) REFERENCES provider_installations(installation_id) ON DELETE RESTRICT
    )`;
  yield* sql`CREATE TABLE notices (
      notice_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      kind TEXT NOT NULL,
      tone TEXT NOT NULL CHECK (tone IN ('info', 'warning', 'error')),
      summary TEXT NOT NULL,
      detail_json TEXT NOT NULL,
      created_at TEXT NOT NULL, presentation_sequence INTEGER CHECK (presentation_sequence >= 0),
      FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
    )`;
  yield* sql`INSERT INTO thread_harness_states SELECT * FROM folder_owned_harness`;
  yield* sql`INSERT INTO thread_runtime_bindings SELECT * FROM folder_owned_bindings`;
  yield* sql`INSERT INTO notices SELECT * FROM folder_owned_notices`;
  yield* sql`CREATE TRIGGER thread_harness_states_compatible_insert
    BEFORE INSERT ON thread_harness_states
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM provider_native_state_generations AS generation
        WHERE generation.native_state_generation_id = NEW.native_state_generation_id
          AND generation.harness_kind = NEW.harness_kind
          AND generation.lifecycle = 'active'
      ) THEN RAISE(ABORT, 'incompatible thread native state generation') END;
    END`;
  yield* sql`CREATE TRIGGER thread_harness_states_compatible_update
    BEFORE UPDATE ON thread_harness_states
    BEGIN
      SELECT CASE WHEN NEW.thread_id != OLD.thread_id OR NEW.harness_kind != OLD.harness_kind
        THEN RAISE(ABORT, 'thread harness identity is immutable') END;
      SELECT CASE WHEN NEW.state_revision != OLD.state_revision + 1
        THEN RAISE(ABORT, 'thread native state revision must increment exactly once') END;
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM provider_native_state_generations AS generation
        WHERE generation.native_state_generation_id = NEW.native_state_generation_id
          AND generation.harness_kind = NEW.harness_kind
          AND generation.lifecycle = 'active'
      ) THEN RAISE(ABORT, 'incompatible thread native state generation') END;
    END`;
  yield* sql`CREATE TRIGGER thread_runtime_bindings_compatible_insert
    BEFORE INSERT ON thread_runtime_bindings
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM thread_harness_states AS state
        JOIN provider_installations AS installation
          ON installation.installation_id = NEW.installation_id
        LEFT JOIN provider_connections AS connection
          ON connection.connection_id = NEW.connection_id
        WHERE state.thread_id = NEW.thread_id
          AND installation.harness_kind = state.harness_kind
          AND installation.lifecycle = 'active'
          AND (
            NEW.connection_id IS NULL OR
            (connection.harness_kind = state.harness_kind AND connection.lifecycle = 'active')
          )
      ) THEN RAISE(ABORT, 'incompatible thread runtime binding') END;
    END`;
  yield* sql`CREATE TRIGGER thread_runtime_bindings_compatible_update
    BEFORE UPDATE ON thread_runtime_bindings
    BEGIN
      SELECT CASE WHEN NEW.thread_id != OLD.thread_id
        THEN RAISE(ABORT, 'thread binding identity is immutable') END;
      SELECT CASE WHEN NEW.binding_revision != OLD.binding_revision + 1
        THEN RAISE(ABORT, 'thread binding revision must increment exactly once') END;
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM thread_harness_states AS state
        JOIN provider_installations AS installation
          ON installation.installation_id = NEW.installation_id
        LEFT JOIN provider_connections AS connection
          ON connection.connection_id = NEW.connection_id
        WHERE state.thread_id = NEW.thread_id
          AND installation.harness_kind = state.harness_kind
          AND (
            (
              NEW.installation_id = OLD.installation_id AND
              installation.lifecycle IN ('active', 'retired')
            ) OR (
              NEW.installation_id != OLD.installation_id AND
              installation.lifecycle = 'active'
            )
          )
          AND (
            NEW.connection_id IS NULL OR
            (connection.harness_kind = state.harness_kind AND connection.lifecycle = 'active')
          )
      ) THEN RAISE(ABORT, 'incompatible thread runtime binding') END;
    END`;
  yield* sql`CREATE INDEX idx_notices_thread_created
    ON notices(thread_id, created_at, notice_id)`;
  yield* sql`DROP TABLE folder_owned_bindings`;
  yield* sql`DROP TABLE folder_owned_harness`;
  yield* sql`DROP TABLE folder_owned_notices`;
  yield* sql`CREATE VIEW thread_activities_read AS
    SELECT
      legacy.activity_id,
      legacy.thread_id,
      legacy.turn_id,
      legacy.tone,
      legacy.kind,
      legacy.summary,
      legacy.payload_json,
      legacy.sequence,
      legacy.created_at
    FROM projection_thread_activities AS legacy
    WHERE NOT EXISTS (
      SELECT 1
      FROM notices
      WHERE notices.notice_id = legacy.activity_id
    )
      AND NOT EXISTS (
        SELECT 1
        FROM operations
        WHERE operations.thread_id = legacy.thread_id
          AND COALESCE(operations.turn_id, '') = COALESCE(legacy.turn_id, '')
          AND operations.provider_operation_id =
            json_extract(legacy.payload_json, '$.operationId')
      )
    UNION ALL
    SELECT
      operation_id AS activity_id,
      thread_id,
      turn_id,
      json_extract(activity_json, '$.tone') AS tone,
      json_extract(activity_json, '$.kind') AS kind,
      json_extract(activity_json, '$.summary') AS summary,
      json_extract(activity_json, '$.payload') AS payload_json,
      presentation_sequence AS sequence,
      updated_at AS created_at
    FROM operations
    UNION ALL
    SELECT
      notice_id AS activity_id,
      thread_id,
      turn_id,
      tone,
      kind,
      summary,
      detail_json AS payload_json,
      presentation_sequence AS sequence,
      created_at
    FROM notices`;
  yield* sql`DROP TABLE projection_thread_decks`;
  const after = (yield* readCounts)[0]!;
  for (const table of ["threads", "items", "harness", "bindings", "notices"] as const) {
    if (after[table] !== before[table]) {
      return yield* Effect.fail(
        new Error(
          `Folder-owned migration changed the ${table} row count: ${before[table]} -> ${after[table]}`,
        ),
      );
    }
  }
  yield* Effect.logInfo("Migrated folder-owned threads", {
    rows: after,
    adoptedFolderRoots: folderRoots.adoptedFolderRoots,
    conflictingFolders: folderRoots.conflictingFolders,
    removedWorkingDirectories: removed.workingDirectories,
    removedDeckMemberships: removed.deckMemberships,
  });
});
