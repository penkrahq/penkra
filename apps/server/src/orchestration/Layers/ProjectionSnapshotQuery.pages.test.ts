// FILE: ProjectionSnapshotQuery.pages.test.ts
// Purpose: Verify bounded agent discovery pages, SQL filters and transcript scope.
import { assert, it } from "@effect/vitest";
import { FolderId, SpaceId } from "@penkra/contracts";
import { Effect, Exit, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  buildFolderShellPageQuery,
  buildThreadShellPageQuery,
  buildTranscriptSearchQuery,
  OrchestrationProjectionSnapshotQueryLive,
} from "./ProjectionSnapshotQuery.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionThreadShellPageInput,
} from "../Services/ProjectionSnapshotQuery.ts";
import { RUNNING_THREADS_SQL } from "../../cleanCore/threadList.ts";
import { createThread } from "../../cleanCore/threadStore.ts";
import { THREADS_PAGE_SIZE } from "@penkra/contracts";
import { deriveAgentThreadStatus } from "../../agentGateway/threadSummary.ts";

const spaceId = SpaceId.makeUnsafe("pages-space");
const now = "2026-10-10T00:00:00.000Z";
const run = <A, E>(effect: Effect.Effect<A, E, ProjectionSnapshotQuery | SqlClient.SqlClient>) =>
  effect.pipe(
    Effect.provide(
      OrchestrationProjectionSnapshotQueryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ),
  );
const seedSpace = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_spaces(space_id, name, icon, sort_order, created_at, updated_at)
    VALUES (${spaceId}, 'Pages', 'home', 0, ${now}, ${now})`;
});
const folder = (id: string, scope = spaceId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_folders(folder_id, space_id, title, workspace_root, created_at, updated_at)
    VALUES (${id}, ${scope}, ${id}, '/repo', ${now}, ${now})`;
  });
const thread = (id: string, folderId = "folder") =>
  createThread({
    id,
    folderId: FolderId.makeUnsafe(folderId),
    spaceId,
    title: id,
    provider: "codex",
    model: "gpt-5.5",
    runtimeMode: "full-access",
    createdBy: "user",
    createdAt: now,
  });
const input = (
  patch: Partial<ProjectionThreadShellPageInput> = {},
): ProjectionThreadShellPageInput => ({
  spaceId,
  threadIds: null,
  folderId: null,
  provider: null,
  model: null,
  createdBy: null,
  updatedAfter: null,
  updatedBefore: null,
  includeArchived: false,
  after: null,
  titleContains: null,
  status: null,
  ...patch,
});

it.effect("reads only requested active folders and rejects batches larger than one page", () =>
  run(
    Effect.gen(function* () {
      yield* seedSpace;
      const ids = Array.from({ length: THREADS_PAGE_SIZE + 1 }, (_, i) =>
        FolderId.makeUnsafe("batch-" + i),
      );
      for (const id of ids) yield* folder(id);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE projection_folders SET archived_at = ${now} WHERE folder_id = ${ids[0]!}`;
      yield* sql`UPDATE projection_folders SET deleted_at = ${now} WHERE folder_id = ${ids[1]!}`;
      const query = yield* ProjectionSnapshotQuery;
      const rows = yield* query.getFolderShellsByIds(ids.slice(0, THREADS_PAGE_SIZE));
      assert.lengthOf(rows, THREADS_PAGE_SIZE - 2);
      assert.isTrue(rows.every((row) => row.workspaceRoot === "/repo" && row.spaceId === spaceId));
      assert.isFalse(rows.some((row) => row.id === ids.at(-1)));
      assert.lengthOf(yield* query.getFolderShellsByIds([FolderId.makeUnsafe("missing")]), 0);
      assert.isTrue(Exit.isFailure(yield* Effect.exit(query.getFolderShellsByIds(ids))));
    }),
  ),
);

it.effect(
  "pages more than 50 folders in creation/id order with full metadata and Space names",
  () =>
    run(
      Effect.gen(function* () {
        yield* seedSpace;
        const sql = yield* SqlClient.SqlClient;
        for (let i = 0; i < THREADS_PAGE_SIZE + 3; i++)
          yield* folder("folder-" + String(i).padStart(2, "0"));
        yield* folder("archived-folder");
        yield* sql`UPDATE projection_folders SET archived_at = ${now} WHERE folder_id = 'archived-folder'`;
        const query = yield* ProjectionSnapshotQuery;
        const first = yield* query.listFolderShellPage(null);
        assert.lengthOf(first.folders, THREADS_PAGE_SIZE);
        assert.isNotNull(first.nextCursor);
        const roundTrip = JSON.parse(JSON.stringify(first.nextCursor));
        const second = yield* query.listFolderShellPage(roundTrip);
        assert.lengthOf(second.folders, 3);
        assert.isNull(second.nextCursor);
        const all = [...first.folders, ...second.folders];
        assert.equal(new Set(all.map((row) => row.id)).size, THREADS_PAGE_SIZE + 3);
        assert.isTrue(
          all.every((row) => row.workspaceRoot === "/repo" && row.spaceTitle === "Pages"),
        );
        assert.deepStrictEqual(
          all.map((row) => row.id),
          Array.from(
            { length: THREADS_PAGE_SIZE + 3 },
            (_, i) => "folder-" + String(i).padStart(2, "0"),
          ),
        );
        const statement = buildFolderShellPageQuery(null);
        const plan = yield* sql.unsafe<{ detail: string }>(
          `EXPLAIN QUERY PLAN ${statement.text}`,
          statement.parameters,
        );
        assert.isTrue(
          plan.some((row) => row.detail.includes("idx_folders_created_live")),
          JSON.stringify(plan),
        );
        assert.isFalse(plan.some((row) => row.detail.includes("TEMP B-TREE")));
      }),
    ),
);

it.effect(
  "pages threads through SQL filters before the page boundary and uses the Space/activity index",
  () =>
    run(
      Effect.gen(function* () {
        yield* seedSpace;
        yield* folder("folder");
        yield* folder("other-folder");
        const sql = yield* SqlClient.SqlClient;
        const query = yield* ProjectionSnapshotQuery;
        for (let i = 0; i < THREADS_PAGE_SIZE + 3; i++)
          yield* thread("thread-" + String(i).padStart(2, "0"));
        yield* thread("specific");
        yield* sql`UPDATE threads SET title = 'NeedLE chosen', provider = 'claudeAgent', model = 'claude-sonnet-4-6',
    created_by = 'agent', updated_at = '2026-10-10T00:00:01.000Z' WHERE id = 'specific'`;
        const rows = yield* query.listThreadShellPage(
          input({
            threadIds: ["specific"],
            folderId: "folder",
            provider: "claudeAgent",
            model: "claude-sonnet-4-6",
            createdBy: "penkra-mcp",
            titleContains: "needle",
            updatedAfter: "2026-10-10T00:00:01.000Z",
            updatedBefore: "2026-10-10T00:00:01.000Z",
            status: "idle",
          }),
        );
        assert.deepStrictEqual(
          rows.threads.map((row) => row.id),
          ["specific"],
        );
        assert.equal(rows.threads[0]!.modelSelection.provider, "claudeAgent");
        const rejected: Partial<ProjectionThreadShellPageInput>[] = [
          { threadIds: [] },
          { spaceId: SpaceId.makeUnsafe("elsewhere") },
          { folderId: "other-folder" },
          { provider: "codex" },
          { model: "other" },
          { createdBy: "human" },
          { titleContains: "absent" },
          { updatedAfter: "2026-10-10T00:00:02.000Z" },
          { updatedBefore: now },
          { status: "working" },
        ];
        for (const patch of rejected) {
          const result = yield* query.listThreadShellPage(
            input({ threadIds: ["specific"], ...patch }),
          );
          assert.deepStrictEqual(result.threads, []);
        }
        yield* sql`UPDATE threads SET archived_at = ${now} WHERE id = 'specific'`;
        assert.lengthOf(
          (yield* query.listThreadShellPage(input({ threadIds: ["specific"] }))).threads,
          0,
        );
        assert.lengthOf(
          (yield* query.listThreadShellPage(
            input({ threadIds: ["specific"], includeArchived: true }),
          )).threads,
          1,
        );
        yield* sql`UPDATE threads SET deleted_at = ${now} WHERE id = 'specific'`;
        const first = yield* query.listThreadShellPage(input());
        const second = yield* query.listThreadShellPage(input({ after: first.nextCursor }));
        assert.lengthOf(first.threads, THREADS_PAGE_SIZE);
        assert.lengthOf(second.threads, 3);
        const all = [...first.threads, ...second.threads];
        assert.equal(new Set(all.map((row) => row.id)).size, THREADS_PAGE_SIZE + 3);
        assert.isNull(second.nextCursor);
        yield* sql`UPDATE projection_folders SET archived_at = ${now} WHERE folder_id = 'folder'`;
        assert.lengthOf(
          (yield* query.listThreadShellPage(input({ includeArchived: true }))).threads,
          0,
        );
        const statement = buildThreadShellPageQuery(input());
        const plan = yield* sql.unsafe<{ parent: number; detail: string }>(
          `EXPLAIN QUERY PLAN ${statement.text}`,
          statement.parameters,
        );
        assert.isTrue(plan.some((row) => row.detail.includes("idx_threads_space_updated_live")));
        assert.isFalse(plan.some((row) => row.parent === 0 && row.detail.includes("TEMP B-TREE")));
      }),
    ),
);

it.effect(
  "maps each agent status through SQL using the same session/turn and pending-input precedence",
  () =>
    run(
      Effect.gen(function* () {
        yield* seedSpace;
        yield* folder("folder");
        const sql = yield* SqlClient.SqlClient;
        const query = yield* ProjectionSnapshotQuery;
        for (const id of ["idle", "working", "error", "interrupted", "waiting-for-user-input"]) {
          yield* thread(id);
          if (id === "waiting-for-user-input")
            yield* sql`UPDATE threads SET open_question_count = 1 WHERE id = ${id}`;
          if (id !== "idle") {
            yield* sql`INSERT INTO projection_thread_sessions(thread_id, status, provider_name, runtime_mode, active_turn_id, updated_at)
        VALUES (${id}, ${id === "working" || id === "waiting-for-user-input" ? "running" : "ready"}, 'codex', 'full-access', NULL, ${now})`;
            yield* sql`INSERT INTO projection_turns(thread_id, turn_id, state, requested_at)
        VALUES (${id}, ${id + "-turn"}, ${id === "waiting-for-user-input" ? "error" : id === "working" ? "running" : id}, ${now})`;
          }
        }
        for (const status of [
          "idle",
          "working",
          "error",
          "interrupted",
          "waiting-for-user-input",
        ]) {
          const result = yield* query.listThreadShellPage(input({ status }));
          assert.deepStrictEqual(
            result.threads.map((row) => row.id),
            [status],
          );
          assert.isTrue(result.threads.every((row) => deriveAgentThreadStatus(row) === status));
        }
        yield* sql`UPDATE projection_thread_sessions SET status = 'starting' WHERE thread_id = 'error'`;
        assert.lengthOf(
          (yield* query.listThreadShellPage(input({ threadIds: ["error"], status: "working" })))
            .threads,
          1,
        );
      }),
    ),
);

it.effect("searches messages by Space, folder and thread with joined title/provider metadata", () =>
  run(
    Effect.gen(function* () {
      yield* seedSpace;
      yield* folder("folder");
      yield* folder("other-folder");
      const sql = yield* SqlClient.SqlClient;
      const query = yield* ProjectionSnapshotQuery;
      for (const id of ["one", "two", "archived", "deleted", "other-space"]) {
        yield* thread(id, id === "two" ? "other-folder" : "folder");
        yield* sql`INSERT INTO projection_thread_messages(message_id, thread_id, role, text, is_streaming, source, created_at, updated_at)
      VALUES (${id + "-message"}, ${id}, 'user', 'needle text', 0, 'native', ${now}, ${now})`;
      }
      yield* sql`UPDATE threads SET archived_at = ${now} WHERE id = 'archived'`;
      yield* sql`UPDATE threads SET deleted_at = ${now} WHERE id = 'deleted'`;
      yield* sql`UPDATE threads SET space_id = 'elsewhere' WHERE id = 'other-space'`;
      const base = {
        spaceId,
        folderId: null,
        threadId: null,
        queries: ["needle"],
        queryMode: "any" as const,
        order: "recent" as const,
      };
      const all = yield* query.searchThreadMessages(base);
      assert.deepStrictEqual(
        all.messages.map((row) => row.threadId),
        ["two", "one"],
      );
      assert.equal(all.messages[0]!.threadTitle, "two");
      assert.equal(all.messages[0]!.threadProvider, "codex");
      assert.deepStrictEqual(
        (yield* query.searchThreadMessages({
          ...base,
          folderId: FolderId.makeUnsafe("folder"),
        })).messages.map((row) => row.threadId),
        ["one"],
      );
      assert.deepStrictEqual(
        (yield* query.searchThreadMessages({
          ...base,
          threadId: all.messages[0]!.threadId,
        })).messages.map((row) => row.threadId),
        ["two"],
      );
      assert.lengthOf(
        (yield* query.searchThreadMessages({ ...base, spaceId: SpaceId.makeUnsafe("elsewhere") }))
          .messages,
        0,
      );
    }),
  ),
);

it.effect("titleContains folds ASCII case without folding Unicode letters", () =>
  run(
    Effect.gen(function* () {
      yield* seedSpace;
      yield* folder("folder");
      yield* thread("unicode-title");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE threads SET title = 'Élan MIXED' WHERE id = 'unicode-title'`;
      const query = yield* ProjectionSnapshotQuery;
      assert.lengthOf((yield* query.listThreadShellPage(input({ titleContains: "é" }))).threads, 0);
      assert.lengthOf((yield* query.listThreadShellPage(input({ titleContains: "É" }))).threads, 1);
      assert.lengthOf(
        (yield* query.listThreadShellPage(input({ titleContains: "mixed" }))).threads,
        1,
      );
    }),
  ),
);

it.effect(
  "pages matching messages without duplicates and matches short, mixed-case, all/any queries",
  () =>
    run(
      Effect.gen(function* () {
        yield* seedSpace;
        yield* folder("folder");
        yield* thread("search-page");
        const sql = yield* SqlClient.SqlClient;
        const query = yield* ProjectionSnapshotQuery;
        for (let i = 0; i < THREADS_PAGE_SIZE + 3; i++) {
          const id = "message-" + String(i).padStart(2, "0");
          yield* sql`INSERT INTO projection_thread_messages(message_id, thread_id, role, text, is_streaming, source, created_at, updated_at)
        VALUES (${id}, 'search-page', 'user', 'Mixed NEEDLE and XY text', 0, 'native', ${now}, ${now})`;
        }
        const base = {
          spaceId,
          folderId: null,
          threadId: null,
          queries: ["needle"],
          queryMode: "any" as const,
          order: "recent" as const,
        };
        const first = yield* query.searchThreadMessages(base);
        assert.lengthOf(first.messages, THREADS_PAGE_SIZE);
        assert.isTrue(first.hasMore);
        const last = first.messages.at(-1)!;
        const second = yield* query.searchThreadMessages({
          ...base,
          anchor: {
            createdAt: last.createdAt,
            threadId: last.threadId,
            messageId: last.messageId,
          },
        });
        assert.lengthOf(second.messages, 3);
        assert.isFalse(second.hasMore);
        assert.equal(
          new Set([...first.messages, ...second.messages].map((row) => row.messageId)).size,
          THREADS_PAGE_SIZE + 3,
        );
        const short = yield* query.searchThreadMessages({ ...base, queries: ["xy"] });
        assert.equal(short.path, "short-query-fallback");
        assert.lengthOf(short.messages, THREADS_PAGE_SIZE);
        const mixedCase = yield* query.searchThreadMessages({ ...base, queries: ["nEeDlE"] });
        assert.deepStrictEqual(mixedCase.messages, first.messages);
        const all = yield* query.searchThreadMessages({
          ...base,
          queries: ["needle", "absent"],
          queryMode: "all",
        });
        assert.lengthOf(all.messages, 0);
        const any = yield* query.searchThreadMessages({ ...base, queries: ["needle", "absent"] });
        assert.deepStrictEqual(any.messages, first.messages);
        const shortAll = yield* query.searchThreadMessages({
          ...base,
          queries: ["xy", "zz"],
          queryMode: "all",
        });
        assert.lengthOf(shortAll.messages, 0);
        const shortAny = yield* query.searchThreadMessages({ ...base, queries: ["xy", "zz"] });
        assert.deepStrictEqual(shortAny.messages, short.messages);
        const indexedStatement = buildTranscriptSearchQuery(base);
        const indexedPlan = yield* sql.unsafe<{ detail: string }>(
          `EXPLAIN QUERY PLAN ${indexedStatement.text}`,
          indexedStatement.parameters,
        );
        assert.isTrue(
          indexedPlan.some(
            (row) =>
              row.detail.includes("projection_thread_messages_search") &&
              row.detail.includes("VIRTUAL TABLE INDEX"),
          ),
          JSON.stringify(indexedPlan),
        );
        const shortStatement = buildTranscriptSearchQuery({ ...base, queries: ["xy"] });
        assert.include(shortStatement.text, "instr(lower(messages.text), lower(?)) > 0");
        const shortPlan = yield* sql.unsafe<{ detail: string }>(
          `EXPLAIN QUERY PLAN ${shortStatement.text}`,
          shortStatement.parameters,
        );
        assert.isTrue(
          shortPlan.some((row) => row.detail.includes("idx_threads_space_updated_live")),
          JSON.stringify(shortPlan),
        );
      }),
    ),
);

it.effect("startup reads navigation and canonical running rows only through their indexes", () =>
  run(
    Effect.gen(function* () {
      yield* seedSpace;
      yield* folder("folder");
      yield* folder("archived-navigation");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE projection_folders SET archived_at = ${now} WHERE folder_id = 'archived-navigation'`;
      yield* thread("idle");
      yield* thread("running");
      yield* thread("archived-running");
      yield* sql`UPDATE threads SET state = 'running' WHERE id IN ('running', 'archived-running')`;
      yield* sql`UPDATE threads SET archived_at = ${now} WHERE id = 'archived-running'`;
      const query = yield* ProjectionSnapshotQuery;
      const snapshot = yield* query.getStartupSnapshot();
      assert.deepEqual(Object.keys(snapshot).sort(), [
        "folders",
        "runningThreads",
        "snapshotSequence",
        "spaces",
      ]);
      assert.deepEqual(
        snapshot.runningThreads.map((row) => row.id),
        ["running"],
      );
      assert.deepEqual(
        snapshot.folders.map((row) => row.id),
        ["folder"],
      );
      for (const [statement, index] of [[RUNNING_THREADS_SQL, "idx_threads_running_live"]]) {
        const plan = yield* sql.unsafe<{ detail: string }>("EXPLAIN QUERY PLAN " + statement);
        assert.isTrue(
          plan.some((row) => row.detail.includes(index!)),
          JSON.stringify(plan),
        );
      }
    }),
  ),
);
