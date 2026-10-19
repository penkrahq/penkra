import { assert, it } from "@effect/vitest";
import { ThreadId } from "@penkra/contracts";
import { threadShellFromRow } from "@penkra/shared/threadView";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { seedThreadFolderFixture } from "../../cleanCore/threadFixtures.ts";
import { createThread } from "../../cleanCore/threadStore.ts";
import { findThread } from "../../cleanCore/threadList.ts";

it.effect(
  "backfills historical timing from each turn's items and preserves real times and row identity",
  () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 211 });
      const sql = yield* SqlClient.SqlClient;
      yield* seedThreadFolderFixture("timing-folder", "space");
      const at = (second: number) => `2026-10-19T00:00:${String(second).padStart(2, "0")}.000Z`;
      for (const id of ["history", "marker-only"])
        yield* createThread({
          id,
          spaceId: "space",
          folderId: "timing-folder",
          title: id,
          provider: "codex",
          model: "model",
          runtimeMode: "full-access",
          createdBy: "user",
          createdAt: at(0),
        });
      yield* sql`INSERT INTO thread_items(thread_id,seq,source_id,turn_id,kind,status,data,created_at,updated_at) VALUES
      ('history',1,'turn:old','old','turn','done','{"startedAt":null,"endedAt":null,"keep":true}',${at(3)},${at(3)}),
      ('history',2,'first','old','text','done',NULL,${at(1)},${at(5)}),
      ('history',3,'last','old','tool','done',NULL,${at(2)},${at(10)}),
      ('history',4,'turn:known','known','turn','done',${JSON.stringify({ startedAt: at(20), endedAt: at(25) })},${at(20)},${at(25)}),
      ('marker-only',1,'turn:alone','alone','turn','done','{"startedAt":null,"endedAt":null}',${at(30)},${at(31)})`;
      const before =
        yield* sql`SELECT rowid,thread_id,seq,source_id,turn_id,kind,status,text,created_at,updated_at FROM thread_items ORDER BY rowid`;
      yield* runMigrations();
      assert.deepStrictEqual(
        yield* sql`SELECT rowid,thread_id,seq,source_id,turn_id,kind,status,text,created_at,updated_at FROM thread_items ORDER BY rowid`,
        before,
      );
      const rows = yield* sql<{
        source_id: string;
        data: string;
      }>`SELECT source_id,data FROM thread_items WHERE kind='turn' ORDER BY rowid`;
      assert.deepStrictEqual(
        rows.map((row) => JSON.parse(row.data)),
        [
          { startedAt: at(1), endedAt: at(10), keep: true },
          { startedAt: at(20), endedAt: at(25) },
          { startedAt: at(30), endedAt: at(31) },
        ],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT count(*) AS missing FROM thread_items WHERE kind='turn' AND json_extract(data,'$.startedAt') IS NULL`,
        [{ missing: 0 }],
      );
      for (const id of ["history", "marker-only"]) {
        const row = yield* findThread(ThreadId.makeUnsafe(id));
        assert.isString(threadShellFromRow(row!).latestTurn!.requestedAt);
      }
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
