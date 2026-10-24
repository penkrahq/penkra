import { observePublisher } from "./cleanCore/threadPublisherTestHelpers.ts";
import { NativeStorageTestLayer } from "./provider/nativeStorage.test-support.ts";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@penkra/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "./persistence/NodeSqliteClient.ts";
import { runMigrations } from "./persistence/Migrations.ts";
import { ServerConfig } from "./config.ts";
import { ServerLifecycleEvents, ServerLifecycleEventsLive } from "./serverLifecycleEvents.ts";
import { ProviderService } from "./provider/Services/ProviderService.ts";
import { ProviderTurnSelectionResolver } from "./provider/Services/ProviderTurnSelectionResolver.ts";
import { ThreadSender } from "./cleanCore/ThreadSender.ts";
import { ThreadPublisher } from "./cleanCore/ThreadPublisher.ts";
import { makeThreadLifecycle, ThreadLifecycle } from "./cleanCore/threadLifecycle.ts";
import { makeThreadPublisher, markThreadVisited } from "./cleanCore/threadStore.ts";
import { listArchivedThreads, restoreThread } from "./cleanCore/archive.ts";
import { runThreadRetentionSweep } from "./threadRetention.ts";

const origin = "2026-01-01T00:00:00.000Z";
const at = "2026-03-10T00:00:00.000Z";
const setup = Effect.gen(function* () {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT OR IGNORE INTO projection_spaces (space_id,name,icon,sort_order,created_at,updated_at) VALUES ('penkra-personal','Personal','circle',0,${origin},${origin})`;
  yield* sql`INSERT INTO projection_folders (folder_id,space_id,title,created_at,updated_at) VALUES ('folder','penkra-personal','Folder',${origin},${origin})`;
  const publisher = makeThreadPublisher();
  const changes: string[] = [];
  yield* observePublisher(publisher.threadChanges, ({ threadId }) => changes.push(threadId));
  let beforeStop: Effect.Effect<void, never> = Effect.void;
  const lifecycle = yield* makeThreadLifecycle.pipe(
    Effect.provide(NativeStorageTestLayer),
    Effect.provideService(ThreadPublisher, publisher),
    Effect.provideService(
      ProviderTurnSelectionResolver,
      {} as typeof ProviderTurnSelectionResolver.Service,
    ),
    Effect.provideService(ThreadSender, {
      runExclusive: (_id, action) => action,
    } as typeof ThreadSender.Service),
    Effect.provideService(ProviderService, {
      stop: () => Effect.suspend(() => beforeStop),
    } as unknown as typeof ProviderService.Service),
    Effect.provideService(ServerConfig, {
      stateDir: "/tmp/penkra-retention-tests-no-native-state",
    } as typeof ServerConfig.Service),
  );
  const seed = (id: string, archivedAt: string | null) =>
    sql`INSERT INTO threads (id,space_id,folder_id,title,provider,model,runtime_mode,state,created_by,created_at,updated_at,archived_at) VALUES (${id},'penkra-personal','folder',${id},'codex','gpt-5.5','full-access','idle','user',${origin},${origin},${archivedAt})`;
  const days = (start: string, count: number) =>
    Effect.gen(function* () {
      for (let i = 0; i < count; i++) {
        const stamp = new Date(Date.parse(start) + i * 24 * 60 * 60 * 1000).toISOString();
        yield* sql`INSERT OR IGNORE INTO retention_active_days VALUES (${stamp.slice(0, 10)},${stamp})`;
      }
    });
  const sweep = (time: string) =>
    runThreadRetentionSweep(time).pipe(Effect.provideService(ThreadLifecycle, lifecycle));
  return {
    sql,
    lifecycle,
    changes,
    seed,
    days,
    sweep,
    beforeStop: (action: Effect.Effect<void, never>) => {
      beforeStop = action;
    },
  };
});
const withDb = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | SqlClient.SqlClient
    | import("effect/Scope").Scope
    | import("./serverLifecycleEvents.ts").ServerLifecycleEvents
  >,
) =>
  effect.pipe(
    Effect.provide(ServerLifecycleEventsLive),
    Effect.provide(NodeSqliteClient.layerMemory()),
  );

it.effect("archives after seven active days, rather than calendar days", () =>
  withDb(
    Effect.gen(function* () {
      const { sql, seed, days, sweep, changes } = yield* setup;
      yield* seed("inactive", null);
      yield* days("2026-01-02T00:00:00.000Z", 6);
      assert.deepStrictEqual(yield* sweep(at), { archivedCount: 0, deletedCount: 0 });
      yield* days("2026-03-09T00:00:00.000Z", 1);
      assert.deepStrictEqual(yield* sweep(at), { archivedCount: 1, deletedCount: 0 });
      assert.deepStrictEqual(yield* sql`SELECT archived_at FROM threads WHERE id='inactive'`, [
        { archived_at: at },
      ]);
      assert.deepStrictEqual(changes, ["inactive"]);
      const events = yield* ServerLifecycleEvents;
      assert.deepStrictEqual(
        (yield* events.snapshot).events.map((e) => e.payload),
        [{ task: "thread-retention", state: "completed", at, archivedCount: 1, deletedCount: 0 }],
      );
    }),
  ),
);
it.effect("does not archive after two months away and one active day", () =>
  withDb(
    Effect.gen(function* () {
      const { seed, days, sweep } = yield* setup;
      yield* seed("away", null);
      yield* days("2026-03-09T00:00:00.000Z", 1);
      assert.deepStrictEqual(yield* sweep(at), { archivedCount: 0, deletedCount: 0 });
    }),
  ),
);
it.effect("skips running, starting, active-turn and open-question chats and recent activity", () =>
  withDb(
    Effect.gen(function* () {
      const { sql, seed, days, sweep } = yield* setup;
      for (const id of [
        "running",
        "starting",
        "turn",
        "question",
        "user-message",
        "visit",
        "updated",
      ])
        yield* seed(id, null);
      yield* sql`UPDATE threads SET state='running' WHERE id='running'`;
      yield* sql`UPDATE threads SET state='starting' WHERE id='starting'`;
      yield* sql`UPDATE threads SET active_turn_id='turn-id' WHERE id='turn'`;
      yield* sql`INSERT INTO thread_items (thread_id,seq,source_id,kind,status,created_at,updated_at) VALUES ('question',1,'open-question','question','open',${origin},${origin})`;
      yield* sql`UPDATE threads SET last_user_message_at=${at} WHERE id='user-message'`;
      yield* sql`UPDATE threads SET last_visited_at=${at} WHERE id='visit'`;
      yield* sql`UPDATE threads SET updated_at=${at} WHERE id='updated'`;
      yield* days("2026-01-02T00:00:00.000Z", 7);
      assert.deepStrictEqual(yield* sweep(at), { archivedCount: 0, deletedCount: 0 });
    }),
  ),
);
it.effect(
  "expires every archived chat after thirty active days and reports the same remaining days",
  () =>
    withDb(
      Effect.gen(function* () {
        const { sql, seed, days, sweep } = yield* setup;
        for (const id of ["user-archive", "automatic-archive"]) yield* seed(id, origin);
        yield* days("2026-01-02T00:00:00.000Z", 29);
        const page = yield* listArchivedThreads({ cursor: null });
        assert.deepStrictEqual(
          page.threads.map((t) => t.deletesInActiveDays),
          [1, 1],
        );
        assert.deepStrictEqual(yield* sweep(at), { archivedCount: 0, deletedCount: 0 });
        yield* days("2026-02-01T00:00:00.000Z", 1);
        assert.deepStrictEqual(
          (yield* listArchivedThreads({ cursor: null })).threads.map((t) => t.deletesInActiveDays),
          [0, 0],
        );
        assert.deepStrictEqual(yield* sweep(at), { archivedCount: 0, deletedCount: 2 });
        assert.equal((yield* sql`SELECT id FROM threads WHERE deleted_at IS NOT NULL`).length, 2);
      }),
    ),
);
it.effect("restoring and archiving again restarts expiry", () =>
  withDb(
    Effect.gen(function* () {
      const { seed, days, lifecycle, sweep } = yield* setup;
      const threadId = ThreadId.make("restored");
      yield* seed(threadId, origin);
      yield* days("2026-01-02T00:00:00.000Z", 30);
      yield* restoreThread({ threadId, updatedAt: at });
      yield* lifecycle.update({ action: "archive", threadId, archivedAt: at, updatedAt: at });
      assert.equal(
        (yield* listArchivedThreads({ cursor: null })).threads[0]!.deletesInActiveDays,
        30,
      );
      assert.deepStrictEqual(yield* sweep(at), { archivedCount: 0, deletedCount: 0 });
      yield* days("2026-03-11T00:00:00.000Z", 1);
      assert.equal(
        (yield* listArchivedThreads({ cursor: null })).threads[0]!.deletesInActiveDays,
        29,
      );
    }),
  ),
);
it.effect("skips stale activity guards and a chat restored after expiry selection", () =>
  withDb(
    Effect.gen(function* () {
      const { seed, sql, lifecycle, changes } = yield* setup;
      const threadId = ThreadId.make("touched");
      yield* seed(threadId, null);
      yield* markThreadVisited({ threadId, visitedAt: at, updatedAt: at });
      assert.isFalse(
        yield* lifecycle.archiveInactive({
          threadId,
          archivedAt: at,
          expectedUpdatedAt: origin,
          expectedLastVisitedAt: null,
        }),
      );
      yield* sql`UPDATE threads SET last_visited_at=NULL, updated_at=${at} WHERE id=${threadId}`;
      assert.isFalse(
        yield* lifecycle.archiveInactive({
          threadId,
          archivedAt: at,
          expectedUpdatedAt: origin,
          expectedLastVisitedAt: null,
        }),
      );
      yield* seed("restored-before-delete", origin);
      const restoredId = ThreadId.make("restored-before-delete");
      yield* restoreThread({ threadId: restoredId, updatedAt: at });
      assert.isFalse(
        yield* lifecycle.deleteExpired({
          threadId: restoredId,
          deletedAt: at,
          expectedArchivedAt: origin,
        }),
      );
      assert.deepStrictEqual(changes, []);
    }),
  ),
);
it.effect("records each UTC visit day once alongside the visit write", () =>
  withDb(
    Effect.gen(function* () {
      const { seed, sql } = yield* setup;
      const threadId = ThreadId.make("visited");
      yield* seed(threadId, null);
      const first = "2026-03-09T22:00:00.000Z";
      yield* markThreadVisited({ threadId, visitedAt: first, updatedAt: first });
      yield* markThreadVisited({
        threadId,
        visitedAt: "2026-03-09T23:00:00.000Z",
        updatedAt: "2026-03-09T23:00:00.000Z",
      });
      yield* markThreadVisited({ threadId, visitedAt: at, updatedAt: at });
      yield* markThreadVisited({ threadId, visitedAt: at, updatedAt: at });
      assert.deepStrictEqual(yield* sql`SELECT * FROM retention_active_days ORDER BY day_utc`, [
        { day_utc: "2026-03-09", first_seen_at: first },
        { day_utc: "2026-03-10", first_seen_at: at },
      ]);
      assert.deepStrictEqual(yield* sql`SELECT last_visited_at FROM threads WHERE id=${threadId}`, [
        { last_visited_at: at },
      ]);
    }),
  ),
);

it.effect("guard misses skip cleanup, and cleanup failure rolls back the guarded archive", () =>
  withDb(
    Effect.gen(function* () {
      const { seed, sql, lifecycle, changes, beforeStop } = yield* setup;
      const threadId = ThreadId.make("cleanup-failure");
      yield* seed(threadId, null);
      let cleanupCount = 0;
      beforeStop(
        Effect.sync(() => {
          cleanupCount++;
          throw new Error("cleanup failed");
        }),
      );
      assert.isFalse(
        yield* lifecycle.archiveInactive({
          threadId,
          archivedAt: at,
          expectedUpdatedAt: at,
          expectedLastVisitedAt: null,
        }),
      );
      assert.equal(cleanupCount, 0);
      const result = yield* lifecycle
        .archiveInactive({
          threadId,
          archivedAt: at,
          expectedUpdatedAt: origin,
          expectedLastVisitedAt: null,
        })
        .pipe(Effect.exit);
      assert.equal(result._tag, "Failure");
      assert.equal(cleanupCount, 1);
      assert.deepStrictEqual(yield* sql`SELECT archived_at FROM threads WHERE id=${threadId}`, [
        { archived_at: null },
      ]);
      assert.deepStrictEqual(changes, []);
    }),
  ),
);
it.effect("rolls back the visit when active-day recording fails", () =>
  withDb(
    Effect.gen(function* () {
      const { seed, sql } = yield* setup;
      const threadId = ThreadId.make("atomic-visit");
      yield* seed(threadId, null);
      yield* sql`CREATE TRIGGER fail_active_day BEFORE INSERT ON retention_active_days BEGIN SELECT RAISE(ABORT, 'injected active-day failure'); END`;
      const error = yield* markThreadVisited({ threadId, visitedAt: at, updatedAt: at }).pipe(
        Effect.flip,
      );
      assert.include(String(error.cause), "injected active-day failure");
      assert.deepStrictEqual(
        yield* sql`SELECT last_visited_at,updated_at FROM threads WHERE id=${threadId}`,
        [{ last_visited_at: null, updated_at: origin }],
      );
    }),
  ),
);
