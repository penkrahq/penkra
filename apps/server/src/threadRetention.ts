// FILE: threadRetention.ts
// Purpose: Keep active-day retention on canonical chats, using guarded lifecycle writes.
import type { ThreadId } from "@penkra/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ThreadLifecycle } from "./cleanCore/threadLifecycle.ts";
import { ServerLifecycleEvents } from "./serverLifecycleEvents.ts";

export const THREAD_RETENTION_UNUSED_ACTIVE_DAYS = 7;
export const THREAD_RETENTION_ARCHIVED_ACTIVE_DAYS = 30;
export const THREAD_RETENTION_INITIAL_SWEEP_DELAY_MS = 5 * 60 * 1000;
export const THREAD_RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const THREAD_RETENTION_BATCH_SIZE = 25;
const THREAD_RETENTION_BATCH_PAUSE_MS = 50;

/** Expressions come from our SQL builders, never from request text. */
export const activeDaysAfterSql = (timestampExpression: string) =>
  `(SELECT COUNT(*) FROM retention_active_days WHERE day_utc > substr(${timestampExpression}, 1, 10))`;
export const archivedDaysRemainingSql = (timestampExpression: string) =>
  `MAX(0, ${THREAD_RETENTION_ARCHIVED_ACTIVE_DAYS} - ${activeDaysAfterSql(timestampExpression)})`;
const lastActivitySql =
  "MAX(t.created_at, t.updated_at, COALESCE(t.last_user_message_at, t.created_at), COALESCE(t.last_visited_at, t.created_at))";

export const runThreadRetentionSweep = (at: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const lifecycle = yield* ThreadLifecycle;
    const events = yield* ServerLifecycleEvents;
    let started = false;
    let archivedCount = 0;
    let deletedCount = 0;
    const publish = (state: "started" | "progress" | "completed") =>
      events.publish({
        type: "maintenance",
        payload: { task: "thread-retention", state, at, archivedCount, deletedCount },
      });
    for (const phase of ["archive", "delete"] as const) {
      let after: ThreadId | null = null;
      while (true) {
        const predicate =
          phase === "archive"
            ? `t.archived_at IS NULL AND t.state NOT IN ('starting','running') AND t.active_turn_id IS NULL AND NOT EXISTS (SELECT 1 FROM thread_items q WHERE q.thread_id=t.id AND q.kind='question' AND q.status='open') AND ${activeDaysAfterSql(lastActivitySql)} >= ${THREAD_RETENTION_UNUSED_ACTIVE_DAYS}`
            : `t.archived_at IS NOT NULL AND ${archivedDaysRemainingSql("t.archived_at")} = 0`;
        const rows: ReadonlyArray<{
          id: ThreadId;
          updatedAt: string;
          lastVisitedAt: string | null;
          archivedAt: string | null;
        }> = yield* sql.unsafe<{
          id: ThreadId;
          updatedAt: string;
          lastVisitedAt: string | null;
          archivedAt: string | null;
        }>(
          `SELECT t.id, t.updated_at AS "updatedAt", t.last_visited_at AS "lastVisitedAt", t.archived_at AS "archivedAt" FROM threads t WHERE t.deleted_at IS NULL AND ${predicate} ${after === null ? "" : "AND t.id > ?"} ORDER BY t.id LIMIT ?`,
          after === null ? [THREAD_RETENTION_BATCH_SIZE] : [after, THREAD_RETENTION_BATCH_SIZE],
        );
        if (rows.length === 0) break;
        if (!started) {
          started = true;
          yield* publish("started");
        }
        for (const row of rows) {
          const write =
            phase === "archive"
              ? lifecycle.archiveInactive({
                  threadId: row.id,
                  archivedAt: at,
                  expectedUpdatedAt: row.updatedAt,
                  expectedLastVisitedAt: row.lastVisitedAt,
                })
              : lifecycle.deleteExpired({
                  threadId: row.id,
                  deletedAt: at,
                  expectedArchivedAt: row.archivedAt!,
                });
          yield* write.pipe(
            Effect.tap((changed) =>
              Effect.sync(() => {
                if (changed) {
                  if (phase === "archive") archivedCount++;
                  else deletedCount++;
                }
              }),
            ),
            Effect.catch((error) =>
              Effect.logWarning("thread retention write failed", {
                threadId: row.id,
                phase,
                error: String(error),
              }),
            ),
          );
        }
        yield* publish("progress");
        after = rows.at(-1)!.id;
        if (rows.length < THREAD_RETENTION_BATCH_SIZE) break;
        yield* Effect.sleep(THREAD_RETENTION_BATCH_PAUSE_MS);
      }
    }
    if (started) yield* publish("completed");
    return { archivedCount, deletedCount };
  });

export const startThreadRetentionJob = () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const lifecycle = yield* ThreadLifecycle;
    const events = yield* ServerLifecycleEvents;
    const sweep = Effect.suspend(() => runThreadRetentionSweep(new Date().toISOString())).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.provideService(ThreadLifecycle, lifecycle),
      Effect.provideService(ServerLifecycleEvents, events),
      Effect.catch((error) =>
        events.publish({
          type: "maintenance",
          payload: {
            task: "thread-retention",
            state: "failed",
            at: new Date().toISOString(),
            error: String(error),
          },
        }),
      ),
    );
    yield* Effect.gen(function* () {
      yield* Effect.sleep(THREAD_RETENTION_INITIAL_SWEEP_DELAY_MS);
      yield* sweep;
      yield* Effect.forever(
        Effect.sleep(THREAD_RETENTION_SWEEP_INTERVAL_MS).pipe(Effect.flatMap(() => sweep)),
        { disableYield: true },
      );
    }).pipe(Effect.forkScoped);
  });
