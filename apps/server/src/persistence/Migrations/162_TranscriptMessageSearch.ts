import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Deterministic substring search for projected transcript messages.
 *
 * The trigram tokenizer lets SQLite use the FTS index for quoted literal
 * phrases while the owning query verifies the exact ranges before returning
 * them. External-content mode keeps the canonical message projection as the
 * only stored text copy; the virtual table owns only its search index.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS projection_thread_messages_search
    USING fts5(
      text,
      content = 'projection_thread_messages',
      content_rowid = 'rowid',
      tokenize = 'trigram'
    )
  `;

  // This migration is deliberately replay-safe for imported lineages.
  yield* sql`
    INSERT INTO projection_thread_messages_search(projection_thread_messages_search)
    VALUES ('rebuild')
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS projection_thread_messages_search_insert
    AFTER INSERT ON projection_thread_messages BEGIN
      INSERT INTO projection_thread_messages_search(rowid, text)
      VALUES (NEW.rowid, NEW.text);
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS projection_thread_messages_search_update
    AFTER UPDATE OF thread_id, message_id, text ON projection_thread_messages BEGIN
      INSERT INTO projection_thread_messages_search(
        projection_thread_messages_search, rowid, text
      ) VALUES ('delete', OLD.rowid, OLD.text);
      INSERT INTO projection_thread_messages_search(rowid, text)
      VALUES (NEW.rowid, NEW.text);
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS projection_thread_messages_search_delete
    AFTER DELETE ON projection_thread_messages BEGIN
      INSERT INTO projection_thread_messages_search(
        projection_thread_messages_search, rowid, text
      ) VALUES ('delete', OLD.rowid, OLD.text);
    END
  `;
});
