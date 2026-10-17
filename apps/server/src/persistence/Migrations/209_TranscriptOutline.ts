// Frozen transcript ordering migration. Existing rowids and message order survive renumbering.
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const started = performance.now();
  const [warnings] = yield* sql<{ count: number }>`SELECT count(*) AS count FROM thread_items
    WHERE kind='notice' AND json_extract(data,'$.kind')='runtime.warning'`;
  yield* sql`DELETE FROM thread_items WHERE kind='notice' AND json_extract(data,'$.kind')='runtime.warning'`;

  yield* sql`CREATE TEMP TABLE migration209_turnless AS
    SELECT i.rowid AS original_rowid, (
      SELECT p.turn_id FROM thread_items p
      WHERE p.thread_id=i.thread_id AND p.seq<i.seq AND p.turn_id IS NOT NULL
      ORDER BY p.seq DESC LIMIT 1
    ) AS turn_id FROM thread_items i
    WHERE i.turn_id IS NULL AND i.kind IN ('tool','notice','text','reasoning')`;
  yield* sql`CREATE UNIQUE INDEX migration209_turnless_rowid ON migration209_turnless(original_rowid)`;
  const [turnless] = yield* sql<{ attached: number; orphaned: number }>`SELECT
    count(CASE WHEN turn_id IS NOT NULL THEN 1 END) AS attached,
    count(CASE WHEN turn_id IS NULL THEN 1 END) AS orphaned FROM migration209_turnless`;
  yield* sql`UPDATE thread_items SET turn_id=(SELECT a.turn_id FROM migration209_turnless a WHERE a.original_rowid=thread_items.rowid)
    WHERE rowid IN (SELECT original_rowid FROM migration209_turnless WHERE turn_id IS NOT NULL)`;
  yield* sql`DROP TABLE migration209_turnless`;

  yield* sql`CREATE TEMP TABLE migration209_turns AS
    SELECT g.thread_id,g.turn_id,g.sort_seq,g.sort_bias,f.created_at FROM (
      SELECT thread_id,turn_id,MIN(seq) AS first_seq,
        COALESCE(MIN(CASE WHEN kind NOT IN ('user','turn') THEN seq END),MAX(CASE WHEN kind='user' THEN seq END),MIN(seq)) AS sort_seq,
        CASE WHEN count(CASE WHEN kind NOT IN ('user','turn') THEN 1 END)=0 THEN 2 ELSE 0 END AS sort_bias
      FROM thread_items WHERE turn_id IS NOT NULL
      GROUP BY thread_id,turn_id
    ) g JOIN thread_items f ON f.thread_id=g.thread_id AND f.seq=g.first_seq`;
  yield* sql`CREATE UNIQUE INDEX migration209_turns_key ON migration209_turns(thread_id,turn_id)`;
  yield* sql`CREATE TEMP TABLE migration209_missing AS
    SELECT g.* FROM migration209_turns g WHERE NOT EXISTS (
      SELECT 1 FROM thread_items i WHERE i.thread_id=g.thread_id AND i.turn_id=g.turn_id AND i.kind='turn'
    )`;
  const [moved] = yield* sql<{ count: number }>`SELECT count(*) AS count FROM thread_items i
    JOIN migration209_turns g ON g.thread_id=i.thread_id AND g.turn_id=i.turn_id
    WHERE i.kind='turn' AND EXISTS (
      SELECT 1 FROM thread_items n WHERE n.thread_id=i.thread_id AND n.kind<>'turn'
        AND ((n.seq<i.seq AND (n.seq>g.sort_seq OR (n.seq=g.sort_seq AND g.sort_bias=0)))
          OR (n.seq>i.seq AND (n.seq<g.sort_seq OR (n.seq=g.sort_seq AND g.sort_bias=2))))
    )`;
  const [missing] = yield* sql<{
    count: number;
  }>`SELECT count(*) AS count FROM migration209_missing`;
  yield* sql`CREATE TEMP TABLE migration209_order AS
    SELECT original_rowid,thread_id,old_seq,turn_id,created_at,
      ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY sort_seq,sort_bias) AS new_seq
    FROM (
      SELECT i.rowid AS original_rowid,i.thread_id,i.seq AS old_seq,i.turn_id,i.created_at,
        CASE WHEN i.kind='turn' THEN g.sort_seq ELSE i.seq END AS sort_seq,
        CASE WHEN i.kind='turn' THEN g.sort_bias ELSE 1 END AS sort_bias
      FROM thread_items i LEFT JOIN migration209_turns g ON g.thread_id=i.thread_id AND g.turn_id=i.turn_id
      UNION ALL
      SELECT NULL,thread_id,NULL,turn_id,created_at,sort_seq,sort_bias FROM migration209_missing
    )`;
  yield* sql`CREATE UNIQUE INDEX migration209_order_rowid ON migration209_order(original_rowid) WHERE original_rowid IS NOT NULL`;
  yield* sql`ALTER TABLE thread_items ADD COLUMN migration209_seq INTEGER`;
  yield* sql`UPDATE thread_items SET migration209_seq=(SELECT o.new_seq FROM migration209_order o WHERE o.original_rowid=thread_items.rowid)`;
  // Stage outside the positive sequence range: SQLite checks uniqueness per row,
  // not at the end of UPDATE, so directly assigning the positive rank can collide.
  yield* sql`UPDATE thread_items SET seq=-migration209_seq`;
  yield* sql`INSERT INTO thread_items(thread_id,seq,source_id,turn_id,kind,status,data,created_at,updated_at,migration209_seq)
    SELECT thread_id,-new_seq,'turn:'||turn_id,turn_id,'turn','done','{"startedAt":null,"endedAt":null}',created_at,created_at,new_seq
    FROM migration209_order WHERE original_rowid IS NULL`;
  yield* sql`UPDATE thread_items SET seq=migration209_seq`;
  yield* sql`ALTER TABLE thread_items DROP COLUMN migration209_seq`;

  const [invalidAnchors] = yield* sql<{ count: number }>`SELECT count(*) AS count FROM (
    SELECT thread_id,turn_id FROM thread_items WHERE turn_id IS NOT NULL GROUP BY thread_id,turn_id
    HAVING count(CASE WHEN kind='turn' THEN 1 END)<>1
      OR MIN(CASE WHEN kind='turn' THEN seq END)>=MIN(CASE WHEN kind NOT IN ('user','turn') THEN seq END)
  )`;
  const [invalidSequences] = yield* sql<{ count: number }>`SELECT count(*) AS count FROM (
    SELECT thread_id FROM thread_items GROUP BY thread_id HAVING min(seq)<>1 OR max(seq)<>count(*)
  )`;
  const [reordered] = yield* sql<{ count: number }>`SELECT count(*) AS count FROM (
    SELECT o.old_seq,LAG(o.old_seq) OVER (PARTITION BY i.thread_id ORDER BY i.seq) AS previous_seq
    FROM migration209_order o JOIN thread_items i ON i.rowid=o.original_rowid WHERE o.original_rowid IS NOT NULL AND i.kind<>'turn'
  ) WHERE old_seq<=previous_seq`;
  if (invalidAnchors!.count || invalidSequences!.count || reordered!.count)
    return yield* Effect.fail(
      new Error(
        `Transcript outline invariant failed: anchors=${invalidAnchors!.count}, sequences=${invalidSequences!.count}, reordered=${reordered!.count}`,
      ),
    );
  yield* sql`DROP TABLE migration209_order`;
  yield* sql`DROP TABLE migration209_missing`;
  yield* sql`DROP TABLE migration209_turns`;
  yield* sql`CREATE INDEX idx_thread_items_outline ON thread_items(thread_id,seq DESC)
    WHERE kind IN ('user','question','turn') OR turn_id IS NULL`;
  yield* sql`CREATE INDEX idx_thread_items_turn_seq ON thread_items(thread_id,turn_id,seq DESC) WHERE turn_id IS NOT NULL`;
  yield* sql`CREATE INDEX idx_thread_items_turn_text ON thread_items(thread_id,turn_id,seq DESC) WHERE kind='text'`;
  yield* Effect.logInfo("Migrated transcript outline", {
    removedRuntimeWarnings: warnings!.count,
    attachedTurnlessItems: turnless!.attached,
    remainingTurnlessItems: turnless!.orphaned,
    insertedTurnAnchors: missing!.count,
    movedExistingTurnAnchors: moved!.count,
    invalidAnchors: invalidAnchors!.count,
    invalidSequences: invalidSequences!.count,
    reorderedItems: reordered!.count,
    durationMs: performance.now() - started,
  });
});
