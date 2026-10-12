// FILE: threadSearch.test.ts
// Purpose: Verify Space-wide search, transcript hit selection and keyset pagination.
import { assert, it } from "@effect/vitest";
import { FolderId, SpaceId, ThreadId } from "@penkra/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { listThreads, searchThreads } from "./threadList.ts";
import { createThread } from "./threadStore.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";

import { seedThreadFolderFixture } from "./threadFixtures.ts";
const folderId = FolderId.makeUnsafe("search-folder");
const spaceId = SpaceId.makeUnsafe("search-space");
const withDb = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layerMemory()));
const addThread = (id: string, title: string) =>
  createThread({
    id,
    title,
    spaceId,
    folderId,
    provider: "codex",
    model: "gpt-5.5",
    runtimeMode: "full-access",
    createdBy: "user",
    createdAt: "2026-10-10T00:00:00.000Z",
  });
const addMessage = (threadId: string, seq: number, text: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO thread_items(thread_id, seq, source_id, kind, status, text, created_at, updated_at)
    VALUES (${threadId}, ${seq}, ${threadId + ":" + seq}, 'user', 'sent', ${text},
      '2026-10-10T00:00:00.000Z', '2026-10-10T00:00:00.000Z')`;
  });

it.effect("finds a title on an unloaded sidebar page case-insensitively", () =>
  withDb(
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedThreadFolderFixture(folderId, spaceId);
      for (let i = 0; i < 51; i++)
        yield* addThread(String(i).padStart(2, "0"), i === 50 ? "Unloaded NEEDLE" : "Other");
      const sidebar = yield* listThreads({ spaceId, folderId });
      assert.isFalse(sidebar.threads.some((row) => row.id === "50"));
      const result = yield* searchThreads({ spaceId, query: "needle", cursor: null });
      assert.deepStrictEqual(
        result.threads.map((row) => row.id),
        ["50"],
      );
      assert.equal(result.threads[0]!.matchKind, "title");
      assert.isNull(result.threads[0]!.messageId);
      assert.isNull(result.nextCursor);
    }),
  ),
);

it.effect(
  "finds never-opened messages, selects the latest position, prefers titles and excludes inactive or other-Space rows",
  () =>
    withDb(
      Effect.gen(function* () {
        yield* runMigrations();
        yield* seedThreadFolderFixture(folderId, spaceId);
        const sql = yield* SqlClient.SqlClient;
        for (const id of ["message", "title", "archived", "deleted", "elsewhere"]) {
          yield* addThread(id, id === "title" ? "Needle" : "Other");
          yield* addMessage(id, 1, "first needle match");
          yield* addMessage(id, 3, "latest needle match");
          yield* addMessage(id, 4, "unrelated last message");
        }
        yield* sql`UPDATE threads SET archived_at = '2026-10-10T00:00:01.000Z' WHERE id = 'archived'`;
        yield* sql`UPDATE threads SET deleted_at = '2026-10-10T00:00:01.000Z' WHERE id = 'deleted'`;
        yield* sql`UPDATE threads SET space_id = 'elsewhere' WHERE id = 'elsewhere'`;
        const result = yield* searchThreads({ spaceId, query: "needle", cursor: null });
        assert.deepStrictEqual(
          result.threads.map((row) => row.id),
          ["title", "message"],
        );
        assert.isNull(result.threads[0]!.messageId);
        assert.isNull(result.threads[0]!.messageText);
        assert.equal(result.threads[1]!.messageId, "message:3");
        assert.equal(result.threads[1]!.messageText, "latest needle match");
      }),
    ),
);

it.effect(
  "pages titles before messages, activity descending then id, including null activity without duplicates",
  () =>
    withDb(
      Effect.gen(function* () {
        yield* runMigrations();
        yield* seedThreadFolderFixture(folderId, spaceId);
        const sql = yield* SqlClient.SqlClient;
        const expected: string[] = [];
        for (const kind of ["title", "message"]) {
          for (let i = 0; i < 53; i++) {
            const id = kind + "-" + String(i).padStart(2, "0");
            expected.push(id);
            yield* addThread(id, kind === "title" ? "Needle" : "Other");
            if (kind === "message") yield* addMessage(id, 1, "needle");
            const activity =
              i < 2 ? "2026-10-10T00:00:02.000Z" : i < 51 ? "2026-10-10T00:00:01.000Z" : null;
            yield* sql`UPDATE threads SET last_activity_at = ${activity} WHERE id = ${id}`;
          }
        }
        const first = yield* searchThreads({ spaceId, query: "needle", cursor: null });
        assert.lengthOf(first.threads, 50);
        assert.deepStrictEqual(first.nextCursor, {
          matchKind: "title",
          lastActivityAt: "2026-10-10T00:00:01.000Z",
          id: ThreadId.makeUnsafe("title-49"),
        });
        const second = yield* searchThreads({ spaceId, query: "needle", cursor: first.nextCursor });
        assert.lengthOf(second.threads, 50);
        const third = yield* searchThreads({ spaceId, query: "needle", cursor: second.nextCursor });
        assert.isNull(third.nextCursor);
        assert.deepStrictEqual(
          [...first.threads, ...second.threads, ...third.threads].map((row) => row.id),
          expected,
        );
        const nullCursor = yield* searchThreads({
          spaceId,
          query: "needle",
          cursor: {
            matchKind: "message",
            lastActivityAt: null,
            id: ThreadId.makeUnsafe("message-51"),
          },
        });
        assert.deepStrictEqual(
          nullCursor.threads.map((row) => row.id),
          ["message-52"],
        );
      }),
    ),
);

it.effect("treats quotes and FTS operators as literal query text; empty queries list titles", () =>
  withDb(
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedThreadFolderFixture(folderId, spaceId);
      yield* addThread("quoted", "Other");
      yield* addMessage("quoted", 1, 'literal "needle" OR text');
      const result = yield* searchThreads({ spaceId, query: '"needle" OR', cursor: null });
      assert.deepStrictEqual(
        result.threads.map((row) => row.id),
        ["quoted"],
      );
      const empty = yield* searchThreads({ spaceId, query: "", cursor: null });
      assert.equal(empty.threads[0]!.matchKind, "title");
      assert.isNull(empty.threads[0]!.messageId);
    }),
  ),
);

it.effect("turn markers are excluded from transcript search", () =>
  withDb(
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedThreadFolderFixture(folderId, spaceId);
      yield* addThread("turn-search", "Ordinary title");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO thread_items(thread_id,seq,source_id,turn_id,kind,status,text,data,created_at,updated_at)
      VALUES ('turn-search',1,'turn:search','search','turn','done','private timing needle','{}',
        '2026-10-10T00:00:00.000Z','2026-10-10T00:00:00.000Z')`;
      assert.deepStrictEqual(
        (yield* searchThreads({ spaceId, query: "needle", cursor: null })).threads,
        [],
      );
      yield* addMessage("turn-search", 2, "user needle");
      assert.equal(
        (yield* searchThreads({ spaceId, query: "needle", cursor: null })).threads[0]?.messageId,
        "turn-search:2",
      );
    }),
  ),
);
