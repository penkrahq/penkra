// Purpose: Gives every Thread one persistent deck and an order within that deck.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_decks (
      deck_id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  if (!(yield* columnExists(sql, "projection_threads", "deck_id"))) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN deck_id TEXT`;
  }
  if (!(yield* columnExists(sql, "projection_threads", "deck_sort_order"))) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN deck_sort_order INTEGER NOT NULL DEFAULT 0
    `;
  }

  // The migration is intentionally one Thread -> one deck. Folder and sidebar order
  // remain untouched; grouping begins only when a later deck command moves a Thread.
  yield* sql`
    UPDATE projection_threads
    SET deck_id = 'deck:' || thread_id,
        deck_sort_order = 0
    WHERE deck_id IS NULL
  `;

  yield* sql`
    INSERT INTO projection_thread_decks (deck_id, space_id, created_at, updated_at)
    SELECT
      thread.deck_id,
      folder.space_id,
      thread.created_at,
      thread.updated_at
    FROM projection_threads AS thread
    JOIN projection_folders AS folder ON folder.folder_id = thread.folder_id
    WHERE thread.deleted_at IS NULL
    ON CONFLICT(deck_id) DO UPDATE SET
      space_id = excluded.space_id,
      updated_at = MAX(projection_thread_decks.updated_at, excluded.updated_at)
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_projection_threads_live_deck_order
    ON projection_threads(deck_id, deck_sort_order)
    WHERE deleted_at IS NULL
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_decks_space
    ON projection_thread_decks(space_id, updated_at DESC, deck_id)
  `;

  // Historical migrations are intentionally replayable. When one replays its
  // original pre-deck INSERT, preserve the same canonical migration rule used
  // above: that Thread begins in its own singleton deck.
  yield* sql`DROP TRIGGER IF EXISTS projection_threads_require_deck_insert`;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS projection_threads_assign_singleton_deck
    AFTER INSERT ON projection_threads
    WHEN NEW.deck_id IS NULL
    BEGIN
      UPDATE projection_threads
      SET deck_id = 'deck:' || NEW.thread_id,
          deck_sort_order = 0
      WHERE thread_id = NEW.thread_id;
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS projection_threads_require_deck_update
    BEFORE UPDATE OF deck_id ON projection_threads
    WHEN NEW.deck_id IS NULL
    BEGIN
      SELECT RAISE(ABORT, 'projection thread requires deck_id');
    END
  `;
});
