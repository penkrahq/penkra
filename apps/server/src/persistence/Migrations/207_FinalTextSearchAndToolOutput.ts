// Freeze the 0.14.4 index policy; never rebuild from the unfiltered content table.
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TRIGGER IF EXISTS thread_items_search_insert`;
  yield* sql`DROP TRIGGER IF EXISTS thread_items_search_update`;
  yield* sql`DROP TRIGGER IF EXISTS thread_items_search_delete`;

  const [interrupted] = yield* sql<{ count: number }>`
    SELECT count(*) AS count FROM thread_items WHERE kind='tool' AND status='streaming'
  `;
  yield* sql`UPDATE thread_items SET status='interrupted' WHERE kind='tool' AND status='streaming'`;
  // Snapshot of INLINE_TOOL_RESULT_BYTES at this migration, not a future runtime policy.
  const [trimmed] = yield* sql<{ count: number }>`
    SELECT count(*) AS count FROM thread_items WHERE kind='tool' AND length(text)>10000
  `;
  yield* sql`UPDATE thread_items SET text=substr(text,1,10000) WHERE kind='tool' AND length(text)>10000`;
  yield* Effect.logInfo("Settled legacy tool output rows", {
    interrupted: interrupted!.count,
    shortened: trimmed!.count,
  });

  yield* sql`
    CREATE TRIGGER thread_items_search_insert AFTER INSERT ON thread_items
      WHEN NEW.kind IN ('user','text') AND NEW.status <> 'streaming' BEGIN
      INSERT INTO thread_items_search(rowid,text) VALUES (NEW.rowid,NEW.text);
    END
  `;
  yield* sql`
    CREATE TRIGGER thread_items_search_update AFTER UPDATE OF text,status,kind ON thread_items
      WHEN (OLD.kind IN ('user','text') AND OLD.status <> 'streaming')
        OR (NEW.kind IN ('user','text') AND NEW.status <> 'streaming') BEGIN
      INSERT INTO thread_items_search(thread_items_search,rowid,text)
        SELECT 'delete',OLD.rowid,OLD.text WHERE OLD.kind IN ('user','text') AND OLD.status <> 'streaming';
      INSERT INTO thread_items_search(rowid,text)
        SELECT NEW.rowid,NEW.text WHERE NEW.kind IN ('user','text') AND NEW.status <> 'streaming';
    END
  `;
  yield* sql`
    CREATE TRIGGER thread_items_search_delete AFTER DELETE ON thread_items
      WHEN OLD.kind IN ('user','text') AND OLD.status <> 'streaming' BEGIN
      INSERT INTO thread_items_search(thread_items_search,rowid,text) VALUES ('delete',OLD.rowid,OLD.text);
    END
  `;
  const size = sql<{ bytes: number }>`
    SELECT COALESCE(sum(pgsize),0) AS bytes FROM dbstat
    WHERE name IN ('thread_items_search_data','thread_items_search_idx',
      'thread_items_search_docsize','thread_items_search_config')
  `;
  const [before] = yield* size;
  const started = performance.now();
  yield* sql`INSERT INTO thread_items_search(thread_items_search) VALUES ('delete-all')`;
  yield* sql`INSERT INTO thread_items_search(rowid,text)
    SELECT rowid,text FROM thread_items WHERE kind IN ('user','text') AND status <> 'streaming'`;
  const rebuildMs = performance.now() - started;
  const [after] = yield* size;
  const [extra] = yield* sql<{ count: number }>`SELECT count(*) AS count FROM (
    SELECT id FROM thread_items_search_docsize EXCEPT
    SELECT rowid FROM thread_items WHERE kind IN ('user','text') AND status <> 'streaming')`;
  const [missing] = yield* sql<{ count: number }>`SELECT count(*) AS count FROM (
    SELECT rowid FROM thread_items WHERE kind IN ('user','text') AND status <> 'streaming'
    EXCEPT SELECT id FROM thread_items_search_docsize)`;
  if (extra!.count !== 0 || missing!.count !== 0)
    return yield* Effect.fail(
      new Error("Final-text search index membership does not match retained conversation rows."),
    );
  yield* sql`INSERT INTO thread_items_search(thread_items_search) VALUES ('integrity-check')`;
  yield* Effect.logInfo("Rebuilt final conversation text search", {
    rebuildMs,
    beforeBytes: before!.bytes,
    afterBytes: after!.bytes,
    extraDocuments: extra!.count,
    missingDocuments: missing!.count,
  });
});
