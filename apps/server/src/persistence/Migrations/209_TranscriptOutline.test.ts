import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { seedThreadFolderFixture } from "../../cleanCore/threadFixtures.ts";
import { createThread } from "../../cleanCore/threadStore.ts";

const at = "2026-10-17T00:00:00.000Z";
const seed = Effect.gen(function* () {
  yield* runMigrations({ toMigrationInclusive: 208 });
  yield* seedThreadFolderFixture("outline-folder", "outline-space");
  for (const id of ["a", "b"])
    yield* createThread({
      id,
      spaceId: "outline-space",
      folderId: "outline-folder",
      title: id,
      provider: "codex",
      model: "model",
      runtimeMode: "full-access",
      createdBy: "user",
      createdAt: at,
    });
});

it.effect("rolls back every change when a turn has duplicate anchors", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    for (const [seq, source, kind, turn, data] of [
      [1, "text", "text", "late", "{}"],
      [2, "turn:late", "turn", "late", '{"startedAt":null,"endedAt":null}'],
      [3, "warning", "notice", null, '{"kind":"runtime.warning"}'],
      [4, "duplicate-anchor", "turn", "late", '{"startedAt":null,"endedAt":null}'],
    ] as const)
      yield* sql`INSERT INTO thread_items(thread_id,seq,source_id,turn_id,kind,status,text,data,created_at,updated_at)
      VALUES ('a',${seq},${source},${turn},${kind},'done','unchanged',${data},${at},${at})`;
    const before = yield* sql`SELECT rowid,* FROM thread_items ORDER BY seq`;
    const result = yield* Effect.exit(runMigrations({ toMigrationInclusive: 209 }));
    assert.equal(result._tag, "Failure");
    assert.deepStrictEqual(yield* sql`SELECT rowid,* FROM thread_items ORDER BY seq`, before);
    assert.deepStrictEqual(
      yield* sql`SELECT name FROM sqlite_master WHERE name='idx_thread_items_outline'`,
      [],
    );
    assert.deepStrictEqual(
      yield* sql`SELECT max(migration_id) AS latest FROM effect_sql_migrations`,
      [{ latest: 208 }],
    );
    assert.deepStrictEqual(
      yield* sql`SELECT name FROM pragma_table_info('thread_items') WHERE name LIKE 'migration209%'`,
      [],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect(
  "moves late existing anchors without changing their identity, timing or message order",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      for (const [seq, source, kind] of [
        [1, "user", "user"],
        [2, "tool", "tool"],
        [3, "steer", "user"],
        [4, "turn:late", "turn"],
        [5, "text", "text"],
      ] as const)
        yield* sql`INSERT INTO thread_items(thread_id,seq,source_id,turn_id,kind,status,text,data,created_at,updated_at)
        VALUES ('a',${seq},${source},'late',${kind},'done','needle', '{"startedAt":"start","endedAt":"end"}',${at},${at})`;
      const [before] =
        yield* sql`SELECT rowid,source_id,status,data,created_at,updated_at FROM thread_items WHERE kind='turn'`;
      yield* runMigrations({ toMigrationInclusive: 209 });
      assert.deepStrictEqual(
        yield* sql`SELECT source_id FROM thread_items ORDER BY seq`,
        ["user", "turn:late", "tool", "steer", "text"].map((source_id) => ({ source_id })),
      );
      assert.deepStrictEqual(
        yield* sql`SELECT rowid,source_id,status,data,created_at,updated_at FROM thread_items WHERE kind='turn'`,
        [before!],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect(
  "merges anchors without collisions, preserves rowids/order/search, and leaves genuine orphans",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const fixtures = [
        ["a", 2, "orphan", null, "text"],
        ["a", 4, "user-a", "A", "user"],
        ["a", 5, "text-b", "B", "text"],
        ["a", 6, "turnless-b", null, "tool"],
        ["a", 7, "warning", null, "notice"],
        ["a", 8, "user-c", "C", "user"],
        ["a", 9, "turn:C", "C", "turn"],
        ["a", 10, "text-c", "C", "text"],
        ["a", 11, "steer-c", "C", "user"],
        ["a", 12, "question-c", "C", "question"],
        ["b", 1, "orphan-b", null, "tool"],
        ["b", 2, "turn:D", "D", "turn"],
        ["b", 3, "turnless-d", null, "tool"],
        ["b", 4, "user-e", "E", "user"],
      ] as const;
      for (const [thread, seq, source, turn, kind] of fixtures) {
        const data =
          source === "warning"
            ? '{"kind":"runtime.warning"}'
            : kind === "turn"
              ? '{"startedAt":"2026-10-17T00:00:00.000Z","endedAt":"2026-10-17T00:01:00.000Z"}'
              : "{}";
        yield* sql`INSERT INTO thread_items(thread_id,seq,source_id,turn_id,kind,status,text,data,created_at,updated_at)
        VALUES (${thread},${seq},${source},${turn},${kind},'done',${"needle " + source},${data},${at},${at})`;
      }
      const before = yield* sql<{
        rowid: number;
        source_id: string;
        thread_id: string;
      }>`SELECT rowid,source_id,thread_id FROM thread_items WHERE source_id<>'warning' ORDER BY thread_id,seq`;
      const searchBefore =
        yield* sql`SELECT rowid FROM thread_items_search WHERE thread_items_search MATCH 'needle' ORDER BY rowid`;
      yield* runMigrations({ toMigrationInclusive: 209 });
      const rows = yield* sql<{
        seq: number;
        source_id: string;
        turn_id: string | null;
        thread_id: string;
        rowid: number;
      }>`SELECT rowid,thread_id,seq,source_id,turn_id FROM thread_items ORDER BY thread_id,seq`;
      assert.deepStrictEqual(
        rows.filter((r) => r.thread_id === "a").map((r) => r.source_id),
        [
          "orphan",
          "user-a",
          "turn:A",
          "turn:B",
          "text-b",
          "turnless-b",
          "user-c",
          "turn:C",
          "text-c",
          "steer-c",
          "question-c",
        ],
      );
      assert.deepStrictEqual(
        rows.filter((r) => r.thread_id === "b").map((r) => r.source_id),
        ["orphan-b", "turn:D", "turnless-d", "user-e", "turn:E"],
      );
      const originalIds = new Set(before.map((r) => r.rowid));
      assert.deepStrictEqual(
        rows
          .filter((r) => originalIds.has(r.rowid))
          .map(({ rowid, source_id, thread_id }) => ({ rowid, source_id, thread_id })),
        before,
      );
      for (const thread of ["a", "b"])
        assert.deepStrictEqual(
          rows.filter((r) => r.thread_id === thread).map((r) => r.seq),
          rows.filter((r) => r.thread_id === thread).map((_, i) => i + 1),
        );
      assert.equal(rows.find((r) => r.source_id === "turnless-b")!.turn_id, "B");
      assert.equal(rows.find((r) => r.source_id === "turnless-d")!.turn_id, "D");
      assert.isNull(rows.find((r) => r.source_id === "orphan")!.turn_id);
      assert.isNull(rows.find((r) => r.source_id === "orphan-b")!.turn_id);
      assert.deepStrictEqual(
        yield* sql`SELECT rowid FROM thread_items_search WHERE thread_items_search MATCH 'needle' ORDER BY rowid`,
        searchBefore,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT data,created_at,updated_at FROM thread_items WHERE source_id='turn:A'`,
        [{ data: '{"startedAt":null,"endedAt":null}', created_at: at, updated_at: at }],
      );
      assert.deepStrictEqual(yield* sql`SELECT data FROM thread_items WHERE source_id='turn:C'`, [
        { data: '{"startedAt":"2026-10-17T00:00:00.000Z","endedAt":"2026-10-17T00:01:00.000Z"}' },
      ]);
      yield* sql`INSERT INTO thread_items_search(thread_items_search) VALUES ('integrity-check')`;
      const indexes = yield* sql<{
        name: string;
      }>`SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_thread_items_outline','idx_thread_items_turn_seq','idx_thread_items_turn_text') ORDER BY name`;
      assert.equal(indexes.length, 3);
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM pragma_table_info('thread_items') WHERE name LIKE 'migration209%'`,
        [],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
