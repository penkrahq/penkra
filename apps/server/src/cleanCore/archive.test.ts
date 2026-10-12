import { assert, it } from "@effect/vitest";
import { ThreadId, SpaceId, FolderId } from "@penkra/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  listArchivedNavigation,
  listArchivedThreads,
  restoreThread,
  buildArchivedThreadsQuery,
} from "./archive.ts";

const timestamp = "2026-10-10T00:00:00.000Z";
const fixture = Effect.gen(function* () {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_spaces (space_id,name,icon,sort_order,created_at,updated_at,archived_at) VALUES ('archive-space','Work','bag',1,${timestamp},${timestamp},${timestamp})`;
  yield* sql`INSERT INTO projection_folders (folder_id,title,space_id,workspace_root,created_at,updated_at,archived_at,icon_data_url) VALUES ('archive-folder','Notes','archive-space',NULL,${timestamp},${timestamp},${timestamp},'data:image/png;base64,aGVsbG8=')`;
  for (let i = 0; i < 120; i++) {
    yield* sql`INSERT INTO threads (id,space_id,folder_id,title,provider,model,runtime_mode,state,created_by,created_at,updated_at,archived_at) VALUES (${`chat-${String(i).padStart(3, "0")}`},'archive-space','archive-folder','Archived chat','codex','gpt-5.5','full-access','idle','user',${timestamp},${timestamp},${i < 60 ? timestamp : "2026-10-09T00:00:00.000Z"})`;
  }
});
const withDb = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layerMemory()));

it.effect("reads archived navigation counts and chat keyset pages through the archive index", () =>
  withDb(
    Effect.gen(function* () {
      yield* fixture;
      const sql = yield* SqlClient.SqlClient;
      const nav = yield* listArchivedNavigation();
      assert.deepStrictEqual(nav.spaces, [
        {
          id: SpaceId.makeUnsafe("archive-space"),
          name: "Work",
          folders: 1,
          chats: 120,
          archivedAt: timestamp,
        },
      ]);
      assert.deepStrictEqual(nav.folders, [
        {
          id: FolderId.makeUnsafe("archive-folder"),
          name: "Notes",
          space: "Work",
          chats: 120,
          archivedAt: timestamp,
          iconDataUrl: "data:image/png;base64,aGVsbG8=",
        },
      ]);
      const first = yield* listArchivedThreads({ cursor: null });
      assert.equal(nav.totalChats, 120);
      assert.equal(first.threads.length, 50);
      assert.equal(first.threads[0]?.id, "chat-059");
      assert.isNotNull(first.nextCursor);
      const second = yield* listArchivedThreads({ cursor: first.nextCursor });
      const third = yield* listArchivedThreads({ cursor: second.nextCursor });
      assert.equal(second.threads.length, 50);
      assert.equal(third.threads.length, 20);
      assert.isNull(third.nextCursor);
      const ids = [...first.threads, ...second.threads, ...third.threads].map((t) => t.id);
      assert.equal(new Set(ids).size, 120);
      assert.deepStrictEqual(ids, [
        ...Array.from({ length: 60 }, (_, i) => `chat-${String(59 - i).padStart(3, "0")}`),
        ...Array.from({ length: 60 }, (_, i) => `chat-${String(119 - i).padStart(3, "0")}`),
      ]);
      assert.equal(first.threads[0]?.restoresFolder, true);
      assert.equal(first.threads[0]?.restoresSpace, true);
      for (const cursor of [null, first.nextCursor]) {
        const query = buildArchivedThreadsQuery({ cursor });
        const plan = yield* sql.unsafe<{ detail: string }>(
          `EXPLAIN QUERY PLAN ${query.sql}`,
          query.params,
        );
        assert.isTrue(plan.some((row) => row.detail.includes("idx_threads_archived")));
      }
    }),
  ),
);

it.effect("restores only a chat, leaving its ancestors and sibling archived", () =>
  withDb(
    Effect.gen(function* () {
      yield* fixture;
      const sql = yield* SqlClient.SqlClient;
      const result = yield* restoreThread({
        threadId: ThreadId.makeUnsafe("chat-000"),
        updatedAt: "2026-10-11T00:00:00.000Z",
      });
      assert.isTrue(result);
      const rows = yield* sql<{
        id: string;
        archivedAt: string | null;
      }>`SELECT id,archived_at AS "archivedAt" FROM threads WHERE id IN ('chat-000','chat-001') ORDER BY id`;
      assert.deepStrictEqual(rows, [
        { id: "chat-000", archivedAt: null },
        { id: "chat-001", archivedAt: timestamp },
      ]);
      const folders = yield* sql<{
        archivedAt: string;
      }>`SELECT archived_at AS "archivedAt" FROM projection_folders WHERE folder_id='archive-folder'`;
      const spaces = yield* sql<{
        archivedAt: string;
      }>`SELECT archived_at AS "archivedAt" FROM projection_spaces WHERE space_id='archive-space'`;
      assert.deepStrictEqual(folders, [{ archivedAt: timestamp }]);
      assert.deepStrictEqual(spaces, [{ archivedAt: timestamp }]);
      const repeated = yield* restoreThread({
        threadId: ThreadId.makeUnsafe("chat-000"),
        updatedAt: "2026-10-11T00:00:00.000Z",
      });
      assert.isFalse(repeated);
    }),
  ),
);
