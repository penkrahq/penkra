// FILE: threadRetention.ts
// Purpose: Runs the server-side retention loop that archives inactive orchestration threads.
// Layer: Server maintenance
// Exports: retention constants, inactive-thread selection, and scoped job startup.

import {
  CommandId,
  type OrchestrationReadModel,
  type OrchestrationShellSnapshot,
  type ThreadId,
} from "@penkra/contracts";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";

import type { OrchestrationEngineShape } from "./orchestration/Services/OrchestrationEngine";
import type { ProjectionSnapshotQueryShape } from "./orchestration/Services/ProjectionSnapshotQuery";
import { ServerLifecycleEvents } from "./serverLifecycleEvents";
import type { ThreadPurgeShape } from "./threadPurge";

// The original prefix identifies legacy retention soft-deletes, which must not
// be purged by the deletion reactor. Archive expiry uses a distinct prefix.
export const THREAD_RETENTION_COMMAND_ID_PREFIX = "thread-retention:";
export const THREAD_RETENTION_EXPIRY_COMMAND_ID_PREFIX = "thread-retention-expiry:";

export const THREAD_RETENTION_UNUSED_ACTIVE_DAYS = 7;
export const THREAD_RETENTION_ARCHIVED_ACTIVE_DAYS = 30;
export const THREAD_RETENTION_INITIAL_SWEEP_DELAY_MS = 5 * 60 * 1000;
export const THREAD_RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const THREAD_RETENTION_BATCH_SIZE = 25;
const THREAD_RETENTION_BATCH_PAUSE_MS = 50;

type RetentionThread =
  | OrchestrationReadModel["threads"][number]
  | OrchestrationShellSnapshot["threads"][number];

type RetentionMaintenanceState = "started" | "progress" | "completed" | "failed";

function parseIsoMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function getThreadLastActivityMs(thread: RetentionThread): number | null {
  const activityTimes = [
    thread.latestUserMessageAt,
    thread.lastVisitedAt,
    thread.updatedAt,
    thread.createdAt,
  ]
    .map(parseIsoMs)
    .filter((ms): ms is number => ms !== null);
  return activityTimes.length > 0 ? Math.max(...activityTimes) : null;
}

export function hasActiveDaysAfter(
  activeDays: ReadonlyArray<string>,
  sinceIso: string,
  requiredDays: number,
): boolean {
  const sinceDay = sinceIso.slice(0, 10);
  return new Set(activeDays.filter((day) => day > sinceDay)).size >= requiredDays;
}

function isThreadBusy(thread: RetentionThread): boolean {
  if (thread.session?.status === "starting" || thread.session?.status === "running") {
    return true;
  }
  if (thread.session?.status !== "error" && thread.session?.activeTurnId != null) {
    return true;
  }
  if (thread.latestTurn?.state === "running") {
    return true;
  }
  if (thread.hasPendingApprovals === true || thread.hasPendingUserInput === true) {
    return true;
  }
  return false;
}

function chunkThreadIds(
  threadIds: Iterable<ThreadId>,
  size = THREAD_RETENTION_BATCH_SIZE,
): ThreadId[][] {
  const chunks: ThreadId[][] = [];
  let chunk: ThreadId[] = [];
  for (const threadId of threadIds) {
    chunk.push(threadId);
    if (chunk.length < size) continue;
    chunks.push(chunk);
    chunk = [];
  }
  if (chunk.length > 0) {
    chunks.push(chunk);
  }
  return chunks;
}

const pauseBetweenRetentionBatches = Effect.sleep(THREAD_RETENTION_BATCH_PAUSE_MS);

const publishRetentionMaintenance = Effect.fn("publishRetentionMaintenance")(function* (
  state: RetentionMaintenanceState,
  details: {
    readonly archivedCount?: number;
    readonly deletedCount?: number;
    readonly recoveredCount?: number;
    readonly totalCount?: number;
    readonly error?: string;
  } = {},
) {
  const lifecycleEvents = yield* ServerLifecycleEvents;
  yield* lifecycleEvents
    .publish({
      type: "maintenance",
      payload: {
        task: "thread-retention",
        state,
        at: new Date().toISOString(),
        ...details,
      },
    })
    .pipe(
      Effect.catch((error) =>
        Effect.logDebug("failed to publish thread retention maintenance event").pipe(
          Effect.annotateLogs({ state, error: String(error) }),
        ),
      ),
    );
});

// Picks inactive threads to archive without deleting their data.
export function getInactiveThreadIdsForRetention(
  readModel: Pick<OrchestrationReadModel, "threads"> | Pick<OrchestrationShellSnapshot, "threads">,
  activeDays: ReadonlyArray<string>,
): ThreadId[] {
  const inactiveThreadIds: ThreadId[] = [];

  for (const thread of readModel.threads) {
    if ("deletedAt" in thread && thread.deletedAt !== null) continue;
    if (thread.archivedAt !== null && thread.archivedAt !== undefined) continue;
    if (thread.isPinned === true) continue;
    if (isThreadBusy(thread)) continue;
    const lastActivityMs = getThreadLastActivityMs(thread);
    if (lastActivityMs === null) continue;
    if (
      !hasActiveDaysAfter(
        activeDays,
        new Date(lastActivityMs).toISOString(),
        THREAD_RETENTION_UNUSED_ACTIVE_DAYS,
      )
    )
      continue;
    inactiveThreadIds.push(thread.id);
  }

  return inactiveThreadIds;
}

export const runThreadRetentionSweep = Effect.fn("runThreadRetentionSweep")(function* (
  orchestrationEngine: OrchestrationEngineShape,
  projectionSnapshotQuery: ProjectionSnapshotQueryShape,
  threadPurge: ThreadPurgeShape,
) {
  const shellSnapshot = yield* projectionSnapshotQuery.getShellSnapshot();
  const activeDays = yield* threadPurge.listRetentionActiveDays();
  const inactiveThreadIds = getInactiveThreadIdsForRetention(shellSnapshot, activeDays);
  const shellThreadsById = new Map(shellSnapshot.threads.map((thread) => [thread.id, thread]));
  const legacyHidden = yield* threadPurge.listLegacyRetentionHidden();
  const expiredArchives = (yield* threadPurge.listRetentionArchives()).filter((archive) =>
    hasActiveDaysAfter(activeDays, archive.archivedAt, THREAD_RETENTION_ARCHIVED_ACTIVE_DAYS),
  );
  const expiredArchivesById = new Map(
    expiredArchives.map((archive) => [archive.threadId, archive]),
  );
  const totalCandidateCount = inactiveThreadIds.length;
  let archivedCount = 0;
  let deletedCount = 0;
  let recoveredCount = 0;

  if (inactiveThreadIds.length > 0 || expiredArchives.length > 0 || legacyHidden.length > 0) {
    yield* publishRetentionMaintenance("started", {
      archivedCount,
      deletedCount,
      recoveredCount,
      totalCount: totalCandidateCount + expiredArchives.length + legacyHidden.length,
    });
    yield* Effect.logInfo("archiving inactive orchestration threads").pipe(
      Effect.annotateLogs({ count: inactiveThreadIds.length }),
    );
  }

  yield* Effect.forEach(
    legacyHidden,
    (hidden) =>
      orchestrationEngine
        .dispatch({
          type: "thread.retention-recover",
          commandId: CommandId.makeUnsafe(
            `${THREAD_RETENTION_COMMAND_ID_PREFIX}recover:${randomUUID()}`,
          ),
          threadId: hidden.threadId as ThreadId,
          expectedDeletedAt: hidden.deletedAt,
        })
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              recoveredCount += 1;
            }),
          ),
          Effect.catch((error) =>
            Effect.logWarning("failed to recover legacy hidden thread into Archive", {
              threadId: hidden.threadId,
              error: String(error),
            }),
          ),
        ),
    { concurrency: 1 },
  ).pipe(Effect.asVoid);

  yield* Effect.forEach(
    chunkThreadIds(inactiveThreadIds),
    (threadBatch) =>
      Effect.forEach(
        threadBatch,
        (threadId) => {
          const thread = shellThreadsById.get(threadId);
          if (!thread) return Effect.void;
          return orchestrationEngine
            .dispatch({
              type: "thread.archive",
              commandId: CommandId.makeUnsafe(
                `${THREAD_RETENTION_COMMAND_ID_PREFIX}${randomUUID()}`,
              ),
              threadId,
              expectedUpdatedAt: thread.updatedAt,
              expectedLastVisitedAt: thread.lastVisitedAt ?? null,
            })
            .pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  archivedCount += 1;
                }),
              ),
              Effect.catch((error) =>
                Effect.logWarning("failed to archive inactive thread during retention sweep").pipe(
                  Effect.annotateLogs({
                    threadId,
                    error: String(error),
                  }),
                ),
              ),
            );
        },
        { concurrency: 1 },
      ).pipe(
        Effect.tap(() =>
          publishRetentionMaintenance("progress", {
            archivedCount,
            deletedCount,
            recoveredCount,
            totalCount: totalCandidateCount + expiredArchives.length + legacyHidden.length,
          }),
        ),
        Effect.tap(() => pauseBetweenRetentionBatches),
      ),
    { concurrency: 1 },
  ).pipe(Effect.asVoid);

  yield* Effect.forEach(
    chunkThreadIds(expiredArchives.map((archive) => archive.threadId as ThreadId)),
    (threadBatch) =>
      Effect.forEach(
        threadBatch,
        (threadId) => {
          const archive = expiredArchivesById.get(threadId);
          if (!archive) return Effect.void;
          return orchestrationEngine
            .dispatch({
              type: "thread.delete",
              commandId: CommandId.makeUnsafe(
                `${THREAD_RETENTION_EXPIRY_COMMAND_ID_PREFIX}${randomUUID()}`,
              ),
              threadId,
              expectedArchivedAt: archive.archivedAt,
            })
            .pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  deletedCount += 1;
                }),
              ),
              Effect.catch((error) =>
                Effect.logWarning("failed to delete expired retention archive", {
                  threadId,
                  error: String(error),
                }),
              ),
            );
        },
        { concurrency: 1 },
      ).pipe(
        Effect.tap(() =>
          publishRetentionMaintenance("progress", {
            archivedCount,
            deletedCount,
            recoveredCount,
            totalCount: totalCandidateCount + expiredArchives.length + legacyHidden.length,
          }),
        ),
        Effect.tap(() => pauseBetweenRetentionBatches),
      ),
    { concurrency: 1 },
  ).pipe(Effect.asVoid);

  if (totalCandidateCount > 0 || expiredArchives.length > 0 || legacyHidden.length > 0) {
    yield* publishRetentionMaintenance("completed", {
      archivedCount,
      deletedCount,
      recoveredCount,
      totalCount: totalCandidateCount + expiredArchives.length + legacyHidden.length,
    });
  }
});

export const startThreadRetentionJob = Effect.fn("startThreadRetentionJob")(function* (
  orchestrationEngine: OrchestrationEngineShape,
  projectionSnapshotQuery: ProjectionSnapshotQueryShape,
  threadPurge: ThreadPurgeShape,
) {
  // Give startup/projection bootstrap a short settling window, then run one
  // archive pass promptly so desktop installs do not need to stay open for 24 hours.
  yield* Effect.gen(function* () {
    yield* Effect.sleep(THREAD_RETENTION_INITIAL_SWEEP_DELAY_MS);
    yield* runThreadRetentionSweep(orchestrationEngine, projectionSnapshotQuery, threadPurge);
    yield* Effect.forever(
      Effect.sleep(THREAD_RETENTION_SWEEP_INTERVAL_MS).pipe(
        Effect.flatMap(() =>
          runThreadRetentionSweep(orchestrationEngine, projectionSnapshotQuery, threadPurge),
        ),
      ),
      { disableYield: true },
    );
  }).pipe(Effect.forkScoped);
});
