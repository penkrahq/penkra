import { observePublisher } from "./threadPublisherTestHelpers.ts";
import { toCleanCoreProviderEvents } from "./providerEventBridge.ts";
import { listThreadItemsPage } from "./threadItemsPage.ts";
import { seedThreadFolderFixture } from "./threadFixtures.ts";
import { assert, it } from "@effect/vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Cause, Effect, Exit } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { applyProviderEvent, settleRunningThreadsOnStartup } from "./providerStreamConsumer.ts";
import { createThread, makeThreadPublisher, upsertThreadItem } from "./threadStore.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";

const withDb = <A, E>(
  effect: Effect.Effect<A, E, SqlClient.SqlClient | import("effect/Scope").Scope>,
) => effect.pipe(Effect.provide(NodeSqliteClient.layerMemory()));

const baseThread = {
  id: "thread-1",
  spaceId: "space-1",
  folderId: "core-test-folder",
  title: "Hello",
  provider: "codex",
  model: "gpt-5.5",
  runtimeMode: "full-access",
  createdBy: "user" as const,
  createdAt: "2026-10-09T00:00:00.000Z",
};

it.effect(
  "anchors the first item or delta before a delayed turn start, retaining row identity",
  () =>
    withDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        yield* seedThreadFolderFixture("core-test-folder", "space-1");
        yield* createThread(baseThread);
        const publisher = makeThreadPublisher();
        for (const kind of ["text", "tool"] as const) {
          yield* applyProviderEvent(publisher, {
            type: "delta",
            threadId: baseThread.id,
            turnId: kind,
            sourceId: `delta-${kind}`,
            kind,
            delta: "first",
            at: baseThread.createdAt,
          });
        }
        yield* upsertThreadItem({
          threadId: baseThread.id,
          turnId: "item",
          sourceId: "first-item",
          kind: "question",
          status: "open",
          data: "{}",
          createdAt: baseThread.createdAt,
          updatedAt: baseThread.createdAt,
        });
        for (const turn of ["text", "tool", "item"]) {
          const rows = yield* sql<{
            rowid: number;
            kind: string;
            seq: number;
          }>`SELECT rowid,kind,seq FROM thread_items WHERE thread_id=${baseThread.id} AND turn_id=${turn} ORDER BY seq`;
          assert.equal(rows.length, 2);
          assert.equal(rows[0]!.kind, "turn");
          yield* applyProviderEvent(publisher, {
            type: "turn.started",
            threadId: baseThread.id,
            turnId: turn,
            at: "2026-10-09T00:00:02.000Z",
          });
          const [anchor] = yield* sql<{
            rowid: number;
            seq: number;
            data: string;
          }>`SELECT rowid,seq,data FROM thread_items WHERE thread_id=${baseThread.id} AND source_id=${`turn:${turn}`}`;
          assert.equal(anchor!.rowid, rows[0]!.rowid);
          assert.equal(anchor!.seq, rows[0]!.seq);
          assert.equal(JSON.parse(anchor!.data).startedAt, baseThread.createdAt);
        }
      }),
    ),
);

it.effect("turn start/end drive threads.state; items go through the upsert", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const publisher = makeThreadPublisher();
      yield* runMigrations();
      yield* seedThreadFolderFixture("core-test-folder", "space-1");
      yield* createThread(baseThread);

      yield* applyProviderEvent(publisher, {
        type: "turn.started",
        threadId: "thread-1",
        turnId: "turn-1",
        at: "2026-10-09T00:00:01.000Z",
      });
      yield* applyProviderEvent(publisher, {
        type: "item",
        threadId: "thread-1",
        item: {
          threadId: "thread-1",
          sourceId: "msg-1",
          kind: "text",
          status: "done",
          text: "hi",
          createdAt: "2026-10-09T00:00:01.000Z",
          updatedAt: "2026-10-09T00:00:01.000Z",
        },
      });

      const running = yield* sql<{
        readonly state: string;
        readonly activeTurnId: string | null;
      }>`SELECT state, active_turn_id AS "activeTurnId" FROM threads WHERE id = 'thread-1'`;
      assert.deepStrictEqual(running, [{ state: "running", activeTurnId: "turn-1" }]);

      yield* applyProviderEvent(publisher, {
        type: "turn.ended",
        threadId: "thread-1",
        turnId: "turn-1",
        state: "completed",
        at: "2026-10-09T00:00:02.000Z",
      });
      const idle = yield* sql<{
        readonly state: string;
        readonly activeTurnId: string | null;
      }>`SELECT state, active_turn_id AS "activeTurnId" FROM threads WHERE id = 'thread-1'`;
      assert.deepStrictEqual(idle, [{ state: "idle", activeTurnId: null }]);

      const items = yield* sql<{ readonly sourceId: string }>`
        SELECT source_id AS "sourceId" FROM thread_items WHERE thread_id = 'thread-1' ORDER BY seq
      `;
      assert.deepStrictEqual(items, [{ sourceId: "turn:turn-1" }, { sourceId: "msg-1" }]);
    }),
  ),
);

it.effect("turn error sets threads.state = error with last_error", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const publisher = makeThreadPublisher();
      yield* runMigrations();
      yield* seedThreadFolderFixture("core-test-folder", "space-1");
      yield* createThread(baseThread);
      yield* applyProviderEvent(publisher, {
        type: "turn.ended",
        threadId: "thread-1",
        turnId: "turn-1",
        state: "error",
        error: "boom",
        at: "2026-10-09T00:00:01.000Z",
      });
      const rows = yield* sql<{ readonly state: string; readonly lastError: string }>`
        SELECT state, last_error AS "lastError" FROM threads WHERE id = 'thread-1'
      `;
      assert.deepStrictEqual(rows, [{ state: "error", lastError: "boom" }]);
    }),
  ),
);

it.effect("the first marker event fixes its start time across late and repeated starts", () =>
  withDb(
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedThreadFolderFixture("core-test-folder", "space-1");
      yield* createThread(baseThread);
      const publisher = makeThreadPublisher();
      const sql = yield* SqlClient.SqlClient;
      const first = "2026-10-19T00:00:01.000Z";
      yield* applyProviderEvent(publisher, {
        type: "delta",
        threadId: baseThread.id,
        turnId: "early",
        sourceId: "early-text",
        kind: "text",
        delta: "Early output",
        at: first,
      });
      const [anchor] = yield* sql<{
        data: string;
      }>`SELECT data FROM thread_items WHERE source_id='turn:early'`;
      assert.deepStrictEqual(JSON.parse(anchor!.data), { startedAt: first, endedAt: null });
      yield* sql`UPDATE thread_items SET data=json_set(data,'$.retained',true) WHERE source_id='turn:early'`;
      for (const turnId of ["early", "ordinary"]) {
        const at = "2026-10-19T00:00:02.000Z";
        yield* applyProviderEvent(publisher, {
          type: "turn.started",
          threadId: baseThread.id,
          turnId,
          at,
        });
        yield* applyProviderEvent(publisher, {
          type: "turn.started",
          threadId: baseThread.id,
          turnId,
          at: "2026-10-19T00:00:03.000Z",
        });
        const [row] = yield* sql<{
          data: string;
        }>`SELECT data FROM thread_items WHERE source_id=${`turn:${turnId}`}`;
        assert.equal(JSON.parse(row!.data).startedAt, turnId === "early" ? first : at);
        if (turnId === "early") assert.equal(JSON.parse(row!.data).retained, 1);
        yield* applyProviderEvent(publisher, {
          type: "turn.ended",
          threadId: baseThread.id,
          turnId,
          state: "completed",
          at: "2026-10-19T00:00:04.000Z",
        });
      }
      assert.deepStrictEqual(
        yield* sql`SELECT count(*) AS missing FROM thread_items WHERE kind='turn' AND json_extract(data,'$.startedAt') IS NULL`,
        [{ missing: 0 }],
      );
    }),
  ),
);

it.effect("provider exit idles the thread and records one cutoff notice", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const publisher = makeThreadPublisher();
      yield* runMigrations();
      yield* seedThreadFolderFixture("core-test-folder", "space-1");
      yield* createThread(baseThread);
      yield* applyProviderEvent(publisher, {
        type: "turn.started",
        threadId: "thread-1",
        turnId: "turn-1",
        at: "2026-10-09T00:00:01.000Z",
      });
      yield* applyProviderEvent(publisher, {
        type: "provider.exited",
        threadIds: ["thread-1"],
        at: "2026-10-09T00:00:02.000Z",
      });
      // Idempotent: a second exit adds nothing.
      yield* applyProviderEvent(publisher, {
        type: "provider.exited",
        threadIds: ["thread-1"],
        at: "2026-10-09T00:00:02.000Z",
      });

      const threads = yield* sql<{ readonly state: string }>`
        SELECT state FROM threads WHERE id = 'thread-1'
      `;
      assert.deepStrictEqual(threads, [{ state: "idle" }]);
      const notices = yield* sql<{ readonly text: string; readonly data: string }>`
        SELECT text, data FROM thread_items WHERE thread_id = 'thread-1' AND kind = 'notice'
      `;
      assert.lengthOf(notices, 1);
      assert.equal(notices[0]!.text, "ChatGPT stopped before finishing");
      assert.deepStrictEqual(JSON.parse(notices[0]!.data), {
        tone: "info",
        kind: "provider-stopped",
        summary: "ChatGPT stopped before finishing",
        payload: {},
      });
    }),
  ),
);

it.effect("startup cuts off every running thread, idempotently", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const publisher = makeThreadPublisher();
      yield* runMigrations();
      yield* seedThreadFolderFixture("core-test-folder", "space-1");
      yield* createThread(baseThread);
      yield* createThread({ ...baseThread, id: "thread-2" });
      yield* applyProviderEvent(publisher, {
        type: "turn.started",
        threadId: "thread-1",
        turnId: "turn-1",
        at: "2026-10-09T00:00:01.000Z",
      });

      yield* settleRunningThreadsOnStartup(publisher, "2026-10-09T00:00:05.000Z");
      // A second run at the same startup time must add nothing.
      yield* settleRunningThreadsOnStartup(publisher, "2026-10-09T00:00:05.000Z");

      const threads = yield* sql<{ readonly id: string; readonly state: string }>`
        SELECT id, state FROM threads ORDER BY id
      `;
      assert.deepStrictEqual(threads, [
        { id: "thread-1", state: "idle" },
        { id: "thread-2", state: "idle" },
      ]);
      const notices = yield* sql<{ readonly threadId: string; readonly count: number }>`
        SELECT thread_id AS "threadId", COUNT(*) AS count FROM thread_items
        WHERE kind = 'notice' GROUP BY thread_id ORDER BY thread_id
      `;
      assert.deepStrictEqual(notices, [{ threadId: "thread-1", count: 1 }]);
    }),
  ),
);

it.effect("streaming deltas append to one item; answers update the question in place", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const publisher = makeThreadPublisher();
      yield* runMigrations();
      yield* seedThreadFolderFixture("core-test-folder", "space-1");
      yield* createThread(baseThread);

      yield* applyProviderEvent(publisher, {
        type: "delta",
        threadId: "thread-1",
        sourceId: "msg-1",
        kind: "text",
        delta: "Hello ",
        at: "2026-10-09T00:00:01.000Z",
      });
      yield* applyProviderEvent(publisher, {
        type: "delta",
        threadId: "thread-1",
        sourceId: "msg-1",
        kind: "text",
        delta: "world",
        at: "2026-10-09T00:00:02.000Z",
      });
      const streamed = yield* sql<{
        readonly seq: number;
        readonly status: string;
        readonly text: string;
      }>`
        SELECT seq, status, text FROM thread_items WHERE source_id = 'msg-1'
      `;
      assert.deepStrictEqual(streamed, [{ seq: 1, status: "streaming", text: "Hello world" }]);

      yield* applyProviderEvent(publisher, {
        type: "item",
        threadId: "thread-1",
        item: {
          threadId: "thread-1",
          sourceId: "q-1",
          kind: "question",
          status: "open",
          text: "Which?",
          data: '{"questions":[]}',
          createdAt: "2026-10-09T00:00:03.000Z",
          updatedAt: "2026-10-09T00:00:03.000Z",
        },
      });
      yield* applyProviderEvent(publisher, {
        type: "question.answered",
        threadId: "thread-1",
        sourceId: "q-1",
        answerData: '{"answers":{"q1":"sqlite"}}',
        at: "2026-10-09T00:00:04.000Z",
      });
      const question = yield* sql<{
        readonly status: string;
        readonly data: string;
        readonly text: string;
      }>`
        SELECT status, data, text FROM thread_items WHERE source_id = 'q-1'
      `;
      assert.deepStrictEqual(question, [
        { status: "answered", data: '{"answers":{"q1":"sqlite"}}', text: "Which?" },
      ]);
    }),
  ),
);

it.effect("a replay of the same item event does not create a second row", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* seedThreadFolderFixture("core-test-folder", "space-1");
      yield* createThread(baseThread);
      const item = {
        threadId: "thread-1",
        sourceId: "msg-replay",
        kind: "text" as const,
        status: "streaming",
        text: "partial",
        createdAt: "2026-10-09T00:00:01.000Z",
        updatedAt: "2026-10-09T00:00:01.000Z",
      };
      yield* upsertThreadItem(item);
      yield* upsertThreadItem({ ...item, status: "done", text: "complete" });
      const rows = yield* sql<{ readonly status: string; readonly text: string }>`
        SELECT status, text FROM thread_items WHERE thread_id = 'thread-1'
      `;
      assert.deepStrictEqual(rows, [{ status: "done", text: "complete" }]);
    }),
  ),
);

it.effect("turn end settles that turn's running items to a terminal status", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const publisher = makeThreadPublisher();
      yield* runMigrations();
      yield* seedThreadFolderFixture("core-test-folder", "space-1");
      yield* createThread(baseThread);
      const running = (sourceId: string, turnId: string) => ({
        threadId: "thread-1",
        sourceId,
        turnId,
        kind: "tool" as const,
        status: "running",
        text: sourceId,
        createdAt: "2026-10-09T00:00:01.000Z",
        updatedAt: "2026-10-09T00:00:01.000Z",
      });
      yield* upsertThreadItem(running("tool-turn-1", "turn-1"));
      yield* upsertThreadItem(running("tool-turn-2", "turn-2"));

      yield* applyProviderEvent(publisher, {
        type: "turn.ended",
        threadId: "thread-1",
        turnId: "turn-1",
        state: "interrupted",
        at: "2026-10-09T00:00:02.000Z",
      });

      const rows = yield* sql<{ readonly sourceId: string; readonly status: string }>`
        SELECT source_id AS "sourceId", status FROM thread_items WHERE thread_id = 'thread-1' ORDER BY seq
      `;
      assert.deepStrictEqual(rows, [
        { sourceId: "turn:turn-1", status: "interrupted" },
        { sourceId: "tool-turn-1", status: "interrupted" },
        { sourceId: "turn:turn-2", status: "running" },
        { sourceId: "tool-turn-2", status: "running" },
      ]);
    }),
  ),
);

it.effect("turn end interrupts unfinished tools for completed and error outcomes", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const publisher = makeThreadPublisher();
      yield* runMigrations();
      yield* seedThreadFolderFixture("core-test-folder", "space-1");
      yield* createThread(baseThread);
      const running = (sourceId: string) => ({
        threadId: "thread-1",
        sourceId,
        turnId: "turn-1",
        kind: "tool" as const,
        status: "running",
        text: sourceId,
        createdAt: "2026-10-09T00:00:01.000Z",
        updatedAt: "2026-10-09T00:00:01.000Z",
      });
      yield* upsertThreadItem(running("tool-done"));
      yield* applyProviderEvent(publisher, {
        type: "turn.ended",
        threadId: "thread-1",
        turnId: "turn-1",
        state: "completed",
        at: "2026-10-09T00:00:02.000Z",
      });
      yield* upsertThreadItem(running("tool-error"));
      yield* applyProviderEvent(publisher, {
        type: "turn.ended",
        threadId: "thread-1",
        turnId: "turn-1",
        state: "error",
        error: "boom",
        at: "2026-10-09T00:00:03.000Z",
      });
      const rows = yield* sql<{ readonly sourceId: string; readonly status: string }>`
        SELECT source_id AS "sourceId", status FROM thread_items WHERE thread_id = 'thread-1' ORDER BY seq
      `;
      assert.deepStrictEqual(rows, [
        { sourceId: "turn:turn-1", status: "error" },
        { sourceId: "tool-done", status: "interrupted" },
        { sourceId: "tool-error", status: "interrupted" },
      ]);
    }),
  ),
);

it.effect("provider exit settles every running item to interrupted", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const publisher = makeThreadPublisher();
      yield* runMigrations();
      yield* seedThreadFolderFixture("core-test-folder", "space-1");
      yield* createThread(baseThread);
      yield* applyProviderEvent(publisher, {
        type: "turn.started",
        threadId: "thread-1",
        turnId: "turn-open",
        at: baseThread.createdAt,
      });
      yield* upsertThreadItem({
        threadId: "thread-1",
        sourceId: "tool-open",
        kind: "tool",
        status: "running",
        text: "tool-open",
        createdAt: "2026-10-09T00:00:01.000Z",
        updatedAt: "2026-10-09T00:00:01.000Z",
      });
      yield* applyProviderEvent(publisher, {
        type: "provider.exited",
        threadIds: ["thread-1"],
        at: "2026-10-09T00:00:02.000Z",
      });
      const rows = yield* sql<{ readonly sourceId: string; readonly status: string }>`
        SELECT source_id AS "sourceId", status FROM thread_items
        WHERE thread_id = 'thread-1' AND kind = 'tool'
      `;
      assert.deepStrictEqual(rows, [{ sourceId: "tool-open", status: "interrupted" }]);
    }),
  ),
);

it.effect("an exit before turn start preserves an error state and inserts no cut-off notice", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const publisher = makeThreadPublisher();
      yield* runMigrations();
      yield* seedThreadFolderFixture("core-test-folder", "space-1");
      yield* createThread(baseThread);
      yield* sql`UPDATE threads SET state = 'error', last_error = 'Previous provider error' WHERE id = 'thread-1'`;
      yield* applyProviderEvent(publisher, {
        type: "provider.exited",
        threadIds: ["thread-1"],
        reason: "Launch rejected",
        at: baseThread.createdAt,
      });
      assert.deepStrictEqual(
        yield* sql`SELECT state, last_error FROM threads WHERE id = 'thread-1'`,
        [{ state: "error", last_error: "Previous provider error" }],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT seq FROM thread_items WHERE thread_id = 'thread-1'`,
        [],
      );
    }),
  ),
);

it.effect("a failed turn settlement rolls back state and items and publishes nothing", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const publisher = makeThreadPublisher();
      yield* runMigrations();
      yield* seedThreadFolderFixture("core-test-folder", "space-1");
      yield* createThread(baseThread);
      yield* applyProviderEvent(publisher, {
        type: "turn.started",
        threadId: "thread-1",
        turnId: "turn-1",
        at: baseThread.createdAt,
      });
      yield* upsertThreadItem({
        threadId: "thread-1",
        sourceId: "running-tool",
        turnId: "turn-1",
        kind: "tool",
        status: "running",
        text: "tool",
        createdAt: baseThread.createdAt,
        updatedAt: baseThread.createdAt,
      });
      const changes: unknown[] = [];
      const outcomes: unknown[] = [];
      const unsubscribe = yield* observePublisher(publisher.threadChanges, (change) =>
        changes.push(change),
      );
      const unsubscribeProvider = yield* observePublisher(publisher.providerEvents, (event) =>
        outcomes.push(event),
      );
      yield* sql`CREATE TEMP TRIGGER fail_settlement BEFORE UPDATE OF status ON thread_items
        WHEN NEW.source_id = 'running-tool'
        BEGIN SELECT RAISE(ABORT, 'injected settlement failure'); END`;
      const failed = yield* Effect.exit(
        applyProviderEvent(publisher, {
          type: "turn.ended",
          threadId: "thread-1",
          turnId: "turn-1",
          state: "completed",
          at: "2026-10-09T00:00:02.000Z",
        }),
      );
      assert.isTrue(Exit.isFailure(failed));
      if (Exit.isFailure(failed))
        assert.include(Cause.pretty(failed.cause), "injected settlement failure");
      assert.deepStrictEqual(
        yield* sql`SELECT state, active_turn_id, updated_at FROM threads WHERE id='thread-1'`,
        [{ state: "running", active_turn_id: "turn-1", updated_at: baseThread.createdAt }],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT status FROM thread_items WHERE source_id='running-tool'`,
        [{ status: "running" }],
      );
      assert.deepStrictEqual(yield* sql`SELECT status,data FROM thread_items WHERE kind='turn'`, [
        {
          status: "running",
          data: JSON.stringify({ startedAt: baseThread.createdAt, endedAt: null }),
        },
      ]);
      assert.deepStrictEqual(changes, []);
      assert.deepStrictEqual(outcomes, []);
      yield* sql`DROP TRIGGER fail_settlement`;
      yield* applyProviderEvent(publisher, {
        type: "turn.ended",
        threadId: "thread-1",
        turnId: "turn-1",
        state: "completed",
        at: "2026-10-09T00:00:02.000Z",
      });
      assert.strictEqual(changes.length, 1);
      assert.strictEqual(outcomes.length, 1);
      assert.deepStrictEqual(
        yield* sql`SELECT state, active_turn_id FROM threads WHERE id='thread-1'`,
        [{ state: "idle", active_turn_id: null }],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT status FROM thread_items WHERE source_id='running-tool'`,
        [{ status: "interrupted" }],
      );
      unsubscribe();
      unsubscribeProvider();
    }),
  ),
);

it.effect("a failed cutoff notice rolls back turn and item changes and publishes nothing", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const publisher = makeThreadPublisher();
      yield* runMigrations();
      yield* seedThreadFolderFixture("core-test-folder", "space-1");
      yield* createThread(baseThread);
      yield* applyProviderEvent(publisher, {
        type: "turn.started",
        threadId: "thread-1",
        turnId: "turn-1",
        at: baseThread.createdAt,
      });
      yield* upsertThreadItem({
        threadId: "thread-1",
        sourceId: "streaming-text",
        turnId: "turn-1",
        kind: "text",
        status: "streaming",
        text: "partial",
        createdAt: baseThread.createdAt,
        updatedAt: baseThread.createdAt,
      });
      const changes: unknown[] = [];
      const outcomes: unknown[] = [];
      const unsubscribe = yield* observePublisher(publisher.threadChanges, (change) =>
        changes.push(change),
      );
      const unsubscribeProvider = yield* observePublisher(publisher.providerEvents, (event) =>
        outcomes.push(event),
      );
      yield* sql`CREATE TEMP TRIGGER fail_cutoff BEFORE INSERT ON thread_items
        WHEN NEW.kind = 'notice'
        BEGIN SELECT RAISE(ABORT, 'injected cutoff notice failure'); END`;
      const failed = yield* Effect.exit(
        applyProviderEvent(publisher, {
          type: "provider.exited",
          threadIds: ["thread-1"],
          at: "2026-10-09T00:00:02.000Z",
        }),
      );
      assert.isTrue(Exit.isFailure(failed));
      if (Exit.isFailure(failed))
        assert.include(Cause.pretty(failed.cause), "injected cutoff notice failure");
      assert.deepStrictEqual(
        yield* sql`SELECT state, active_turn_id FROM threads WHERE id='thread-1'`,
        [{ state: "running", active_turn_id: "turn-1" }],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT status FROM thread_items WHERE source_id='streaming-text'`,
        [{ status: "streaming" }],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT source_id FROM thread_items WHERE kind='notice'`,
        [],
      );
      assert.deepStrictEqual(changes, []);
      assert.deepStrictEqual(outcomes, []);
      unsubscribe();
      unsubscribeProvider();
    }),
  ),
);

it.effect(
  "turn end settles streaming text as well as running tools, keeping other turns intact",
  () =>
    withDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const publisher = makeThreadPublisher();
        yield* runMigrations();
        yield* seedThreadFolderFixture("core-test-folder", "space-1");
        yield* createThread(baseThread);
        for (const [sourceId, kind, status, turnId] of [
          ["text", "text", "streaming", "turn"],
          ["tool", "tool", "running", "turn"],
          ["delta-without-turn", "text", "streaming", null],
          ["other-turn", "tool", "running", "other-turn"],
        ] as const) {
          yield* upsertThreadItem({
            threadId: baseThread.id,
            sourceId,
            kind,
            status,
            turnId,
            text: "partial",
            data: null,
            createdAt: baseThread.createdAt,
            updatedAt: baseThread.createdAt,
          });
        }
        yield* applyProviderEvent(publisher, {
          type: "turn.ended",
          threadId: baseThread.id,
          turnId: "turn",
          state: "interrupted",
          at: baseThread.createdAt,
        });
        assert.deepStrictEqual(
          yield* sql`SELECT source_id, status FROM thread_items WHERE thread_id=${baseThread.id} ORDER BY seq`,
          [
            { source_id: "turn:turn", status: "interrupted" },
            { source_id: "text", status: "interrupted" },
            { source_id: "tool", status: "interrupted" },
            { source_id: "delta-without-turn", status: "interrupted" },
            { source_id: "turn:other-turn", status: "running" },
            { source_id: "other-turn", status: "running" },
          ],
        );
      }),
    ),
);

it.effect("provider exit settles streaming items with no turn id", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const publisher = makeThreadPublisher();
      yield* runMigrations();
      yield* seedThreadFolderFixture("core-test-folder", "space-1");
      yield* createThread(baseThread);
      yield* applyProviderEvent(publisher, {
        type: "turn.started",
        threadId: baseThread.id,
        turnId: "turn",
        at: baseThread.createdAt,
      });
      yield* applyProviderEvent(publisher, {
        type: "delta",
        threadId: baseThread.id,
        sourceId: "partial-text",
        kind: "text",
        delta: "partial",
        at: baseThread.createdAt,
      });
      yield* applyProviderEvent(publisher, {
        type: "provider.exited",
        threadIds: [baseThread.id],
        at: baseThread.createdAt,
      });
      assert.deepStrictEqual(
        yield* sql`SELECT status FROM thread_items WHERE source_id='partial-text'`,
        [{ status: "interrupted" }],
      );
    }),
  ),
);

for (const state of ["completed", "error"] as const) {
  it.effect(`${state} turn end interrupts unfinished output and preserves terminal items`, () =>
    withDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const publisher = makeThreadPublisher();
        yield* runMigrations();
        yield* seedThreadFolderFixture("core-test-folder", "space-1");
        yield* createThread(baseThread);
        for (const [sourceId, kind, status] of [
          ["text", "text", "streaming"],
          ["tool", "tool", "running"],
          ["finished-text", "text", "done"],
          ["failed-tool", "tool", "error"],
        ] as const) {
          yield* upsertThreadItem({
            threadId: "thread-1",
            sourceId,
            kind,
            status,
            turnId: "turn",
            text: sourceId,
            createdAt: baseThread.createdAt,
            updatedAt: baseThread.createdAt,
          });
        }
        yield* applyProviderEvent(publisher, {
          type: "turn.ended",
          threadId: "thread-1",
          turnId: "turn",
          state,
          ...(state === "error" ? { error: "provider failure" } : {}),
          at: "2026-10-09T00:00:02.000Z",
        });
        assert.deepStrictEqual(
          yield* sql`SELECT source_id, status FROM thread_items ORDER BY seq`,
          [
            { source_id: "turn:turn", status: state === "completed" ? "done" : "error" },
            { source_id: "text", status: "interrupted" },
            { source_id: "tool", status: "interrupted" },
            { source_id: "finished-text", status: "done" },
            { source_id: "failed-tool", status: "error" },
          ],
        );
      }),
    ),
  );
}

for (const outcome of ["completed", "interrupted", "error"] as const) {
  it.effect(`persists ${outcome} turn timing in the thread state transaction`, () =>
    withDb(
      Effect.gen(function* () {
        yield* runMigrations();
        yield* seedThreadFolderFixture("core-test-folder", "space-1");
        yield* createThread(baseThread);
        const publisher = makeThreadPublisher();
        const startedAt = "2026-10-09T00:00:01.000Z";
        const endedAt = "2026-10-09T00:00:12.000Z";
        yield* applyProviderEvent(publisher, {
          type: "turn.started",
          threadId: baseThread.id,
          turnId: "timed",
          at: startedAt,
        });
        const sql = yield* SqlClient.SqlClient;
        assert.deepStrictEqual(yield* sql`SELECT kind,status,data FROM thread_items`, [
          { kind: "turn", status: "running", data: JSON.stringify({ startedAt, endedAt: null }) },
        ]);
        yield* applyProviderEvent(publisher, {
          type: "turn.ended",
          threadId: baseThread.id,
          turnId: "timed",
          state: outcome,
          at: endedAt,
        });
        assert.deepStrictEqual(yield* sql`SELECT source_id,turn_id,status,data FROM thread_items`, [
          {
            source_id: "turn:timed",
            turn_id: "timed",
            status: outcome === "completed" ? "done" : outcome,
            data: JSON.stringify({ startedAt, endedAt }),
          },
        ]);
        assert.deepStrictEqual(yield* sql`SELECT state,active_turn_id FROM threads`, [
          { state: outcome === "error" ? "error" : "idle", active_turn_id: null },
        ]);
      }),
    ),
  );
}

for (const settledBeforeRestart of [false, true]) {
  it.effect(
    `${settledBeforeRestart ? "completed turn" : "startup cut-off"} timing survives a database reopen`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "penkra-turn-timing-"))),
            (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
          );
          const filename = path.join(directory, "state.sqlite");
          const startedAt = "2026-10-09T00:00:01.000Z";
          const endedAt = "2026-10-09T00:00:12.000Z";
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* runMigrations();
              yield* seedThreadFolderFixture("core-test-folder", "space-1");
              yield* createThread(baseThread);
              yield* applyProviderEvent(makeThreadPublisher(), {
                type: "turn.started",
                threadId: baseThread.id,
                turnId: "restart",
                at: startedAt,
              });
              if (settledBeforeRestart)
                yield* applyProviderEvent(makeThreadPublisher(), {
                  type: "turn.ended",
                  threadId: baseThread.id,
                  turnId: "restart",
                  state: "completed",
                  at: endedAt,
                });
            }).pipe(Effect.provide(NodeSqliteClient.layer({ filename }))),
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* settleRunningThreadsOnStartup(makeThreadPublisher(), endedAt);
              const sql = yield* SqlClient.SqlClient;
              assert.deepStrictEqual(
                yield* sql`SELECT status,data FROM thread_items WHERE kind='turn'`,
                [
                  {
                    status: settledBeforeRestart ? "done" : "interrupted",
                    data: JSON.stringify({ startedAt, endedAt }),
                  },
                ],
              );
            }).pipe(Effect.provide(NodeSqliteClient.layer({ filename }))),
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              const [turn] = yield* sql<{
                status: string;
                data: string;
              }>`SELECT status,data FROM thread_items WHERE kind='turn'`;
              const timing = JSON.parse(turn!.data);
              assert.equal(turn!.status, settledBeforeRestart ? "done" : "interrupted");
              assert.equal(Date.parse(timing.endedAt) - Date.parse(timing.startedAt), 11_000);
            }).pipe(Effect.provide(NodeSqliteClient.layer({ filename }))),
          );
        }),
      ),
  );
}

it.effect("a failed turn-marker insert rolls back running state and publishes nothing", () =>
  withDb(
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedThreadFolderFixture("core-test-folder", "space-1");
      yield* createThread(baseThread);
      const sql = yield* SqlClient.SqlClient;
      const publisher = makeThreadPublisher();
      const changes: unknown[] = [];
      yield* observePublisher(publisher.threadChanges, (change) => changes.push(change));
      yield* observePublisher(publisher.providerEvents, (event) => changes.push(event));
      yield* sql`CREATE TEMP TRIGGER fail_turn_insert BEFORE INSERT ON thread_items WHEN NEW.kind='turn'
      BEGIN SELECT RAISE(ABORT, 'injected turn insert failure'); END`;
      const result = yield* Effect.exit(
        applyProviderEvent(publisher, {
          type: "turn.started",
          threadId: baseThread.id,
          turnId: "rejected",
          at: "2026-10-09T00:00:01.000Z",
        }),
      );
      assert.isTrue(Exit.isFailure(result));
      if (Exit.isFailure(result))
        assert.include(Cause.pretty(result.cause), "injected turn insert failure");
      assert.deepStrictEqual(yield* sql`SELECT state,active_turn_id FROM threads`, [
        { state: "idle", active_turn_id: null },
      ]);
      assert.deepStrictEqual(yield* sql`SELECT * FROM thread_items`, []);
      assert.deepStrictEqual(changes, []);
    }),
  ),
);

it.effect("a provider user echo preserves the admitted row until settlement", () =>
  withDb(
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedThreadFolderFixture("core-test-folder", "space-1");
      yield* createThread(baseThread);
      const publisher = makeThreadPublisher();
      const item = {
        threadId: baseThread.id,
        sourceId: "admitted",
        kind: "user" as const,
        status: "sending",
        text: "prompt",
        data: JSON.stringify({ origin: { _tag: "user" }, attachments: [] }),
        admissionPlan: "deliver" as const,
        createdAt: baseThread.createdAt,
        updatedAt: baseThread.createdAt,
      };
      yield* upsertThreadItem(item);
      const sql = yield* SqlClient.SqlClient;
      const before = yield* sql`SELECT * FROM thread_items WHERE source_id='admitted'`;
      yield* applyProviderEvent(publisher, {
        type: "item",
        threadId: baseThread.id,
        item: {
          ...item,
          status: "sent",
          data: null,
          turnId: "native",
          updatedAt: "2026-10-09T00:00:01.000Z",
        },
      });
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM thread_items WHERE source_id='admitted'`,
        before,
      );
    }),
  ),
);

it.effect("stream-only assistant output retains its turn timing after completion", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const publisher = makeThreadPublisher();
      yield* runMigrations();
      yield* seedThreadFolderFixture("core-test-folder", "space-1");
      yield* createThread(baseThread);
      yield* applyProviderEvent(publisher, {
        type: "turn.started",
        threadId: baseThread.id,
        turnId: "timed-turn",
        at: baseThread.createdAt,
      });
      const deltas = toCleanCoreProviderEvents({
        type: "content.delta",
        eventId: "delta-event",
        provider: "codex",
        threadId: baseThread.id,
        turnId: "timed-turn",
        itemId: "streamed-answer",
        createdAt: baseThread.createdAt,
        payload: { streamKind: "assistant_text", delta: "Done." },
      } as unknown as import("@penkra/contracts").ProviderRuntimeEvent);
      for (const delta of deltas) yield* applyProviderEvent(publisher, delta);
      yield* applyProviderEvent(publisher, {
        type: "turn.ended",
        threadId: baseThread.id,
        turnId: "timed-turn",
        state: "completed",
        at: "2026-10-09T00:00:12.000Z",
      });
      assert.deepStrictEqual(
        yield* sql`SELECT turn_id,status FROM thread_items WHERE source_id='streamed-answer'`,
        [{ turn_id: "timed-turn", status: "interrupted" }],
      );
      const page = yield* listThreadItemsPage({
        threadId: "thread-1" as import("@penkra/contracts").ThreadId,
      });
      assert.deepStrictEqual(JSON.parse(page.turns["timed-turn"]!.data!), {
        startedAt: baseThread.createdAt,
        endedAt: "2026-10-09T00:00:12.000Z",
      });
    }),
  ),
);
