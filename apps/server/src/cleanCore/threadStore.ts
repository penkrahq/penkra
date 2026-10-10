// FILE: threadStore.ts
// Purpose: The clean-core write path — idempotent thread/thread_items writes and
// the in-memory per-thread change publisher (0.14.4 design 2.1/2.2).
// Layer: Server persistence (clean core)
// Exports: makeThreadPublisher, upsertThreadItem, createThread, setThreadArchived,
//   renameThread, setThreadDeleted, setThreadState, updateThreadDraft, answerQuestion,
//   settleRunningItems

import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { capThreadItemData } from "./threadItemData.ts";

export type ThreadItemKind = "user" | "text" | "reasoning" | "tool" | "question" | "notice";

export interface ThreadItemInput {
  readonly threadId: string;
  readonly sourceId: string;
  readonly turnId?: string | null;
  readonly kind: ThreadItemKind;
  readonly status: string;
  readonly text?: string | null;
  readonly data?: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ThreadChange {
  readonly threadId: string;
}

export interface ThreadPublisher {
  /** Subscribe to one thread's changes. Returns an unsubscribe function. */
  readonly subscribe: (threadId: string, listener: (change: ThreadChange) => void) => () => void;
  /** Subscribe to every thread's changes. Returns an unsubscribe function. */
  readonly subscribeAll: (listener: (change: ThreadChange) => void) => () => void;
  readonly publish: (change: ThreadChange) => void;
}

export const makeThreadPublisher = (): ThreadPublisher => {
  const byThread = new Map<string, Set<(change: ThreadChange) => void>>();
  const all = new Set<(change: ThreadChange) => void>();
  return {
    subscribe: (threadId, listener) => {
      const listeners = byThread.get(threadId) ?? new Set();
      listeners.add(listener);
      byThread.set(threadId, listeners);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) byThread.delete(threadId);
      };
    },
    subscribeAll: (listener) => {
      all.add(listener);
      return () => all.delete(listener);
    },
    publish: (change) => {
      for (const listener of byThread.get(change.threadId) ?? []) listener(change);
      for (const listener of all) listener(change);
    },
  };
};

/**
 * The only write path for a transcript item. `seq` is assigned when the
 * source id is first seen and never moves; later updates apply in place.
 * Repeating the same source id is idempotent.
 */
export const upsertThreadItem = (input: ThreadItemInput) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const data = capThreadItemData(input.data ?? null);
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          INSERT INTO thread_items (
            thread_id, seq, source_id, turn_id, kind, status, text, data, created_at, updated_at
          ) VALUES (
            ${input.threadId},
            (SELECT COALESCE(MAX(seq), 0) + 1 FROM thread_items WHERE thread_id = ${input.threadId}),
            ${input.sourceId}, ${input.turnId ?? null}, ${input.kind}, ${input.status},
            ${input.text ?? null}, ${data}, ${input.createdAt}, ${input.updatedAt}
          )
          ON CONFLICT (thread_id, source_id) DO UPDATE SET
            status = excluded.status,
            text = excluded.text,
            data = excluded.data,
            updated_at = excluded.updated_at
        `;
        // 2.1 write rule: the thread's rollup columns move in the same write.
        yield* sql`
          UPDATE threads SET
            last_activity_at = ${input.updatedAt},
            last_message_preview = CASE
              WHEN ${input.kind} IN ('user', 'text') THEN ${input.text ?? null}
              ELSE last_message_preview END,
            last_user_message_at = CASE
              WHEN ${input.kind} = 'user' THEN ${input.updatedAt}
              ELSE last_user_message_at END,
            open_question_count = CASE
              WHEN ${input.kind} = 'question' THEN (
                SELECT COUNT(*) FROM thread_items
                WHERE thread_id = ${input.threadId} AND kind = 'question' AND status = 'open'
              )
              ELSE open_question_count END
          WHERE id = ${input.threadId}
        `;
      }),
    );
  });

interface CreateThreadFields {
  readonly id: string;
  readonly spaceId: string;
  readonly folderId?: string | null;
  readonly title: string;
  readonly provider: string;
  readonly connectionId?: string | null;
  readonly model: string;
  readonly modelOptions?: string | null;
  readonly runtimeMode: string;
  readonly workingDirectory?: string | null;
  readonly providerSessionId?: string | null;
  readonly nativeStateId?: string | null;
  readonly parentThreadId?: string | null;
  readonly deckId?: string | null;
  readonly deckSortOrder?: number;
  readonly sidebarSortOrder?: number | null;
  readonly isPinned?: number;
  readonly createdAt: string;
}

/**
 * `runtimeMode` and `createdBy` are required: neither has a safe default.
 * `createdByThreadId` is required exactly when `createdBy` is `agent`.
 */
export type CreateThreadInput = CreateThreadFields &
  (
    | { readonly createdBy: "agent"; readonly createdByThreadId: string }
    | { readonly createdBy: "user" | "provider_native"; readonly createdByThreadId?: string | null }
  );

/** Client-chosen id; a resend after a dropped connection changes nothing. */
export const createThread = (input: CreateThreadInput) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT OR IGNORE INTO threads (
        id, space_id, folder_id, title, provider, connection_id, model, model_options,
        runtime_mode, working_directory, provider_session_id, native_state_id, state,
        queue, created_by, created_by_thread_id, parent_thread_id, deck_id,
        deck_sort_order, sidebar_sort_order, is_pinned, created_at, updated_at
      ) VALUES (
        ${input.id}, ${input.spaceId}, ${input.folderId ?? null}, ${input.title},
        ${input.provider}, ${input.connectionId ?? null}, ${input.model},
        ${input.modelOptions ?? null}, ${input.runtimeMode},
        ${input.workingDirectory ?? null}, ${input.providerSessionId ?? null},
        ${input.nativeStateId ?? null}, 'idle', '[]', ${input.createdBy},
        ${input.createdByThreadId ?? null}, ${input.parentThreadId ?? null},
        ${input.deckId ?? null}, ${input.deckSortOrder ?? 0},
        ${input.sidebarSortOrder ?? null}, ${input.isPinned ?? 0},
        ${input.createdAt}, ${input.createdAt}
      )
    `;
  });

const updateThread = (id: string, column: "archived_at" | "deleted_at", value: string | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (column === "archived_at") {
      yield* sql`UPDATE threads SET archived_at = ${value}, updated_at = ${value ?? new Date().toISOString()} WHERE id = ${id}`;
    } else {
      yield* sql`UPDATE threads SET deleted_at = ${value}, updated_at = ${value ?? new Date().toISOString()} WHERE id = ${id}`;
    }
  });

/** Archive/unarchive: a plain set-state update; repeating it changes nothing. */
export const setThreadArchived = (id: string, archivedAt: string | null) =>
  updateThread(id, "archived_at", archivedAt);

export const setThreadDeleted = (id: string, deletedAt: string | null) =>
  updateThread(id, "deleted_at", deletedAt);

export const renameThread = (id: string, title: string, updatedAt: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE threads SET title = ${title}, updated_at = ${updatedAt} WHERE id = ${id}`;
  });

export const setThreadState = (
  id: string,
  state: "idle" | "running" | "error",
  activeTurnId: string | null,
  lastError: string | null,
  updatedAt: string,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE threads
      SET state = ${state}, active_turn_id = ${activeTurnId}, last_error = ${lastError},
          updated_at = ${updatedAt}
      WHERE id = ${id}
    `;
  });

export const updateThreadDraft = (id: string, draft: string | null, updatedAt: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE threads
      SET draft = ${draft}, draft_updated_at = ${updatedAt}, updated_at = ${updatedAt}
      WHERE id = ${id} AND (draft_updated_at IS NULL OR draft_updated_at < ${updatedAt})
    `;
  });

/** A sidebar/deck drop position: after a sibling, or the pinned boundary. */
export interface ThreadMovePosition {
  readonly type: "after" | "pinned-boundary";
  readonly itemId?: string | undefined;
}

interface ThreadSiblingRow {
  readonly id: string;
  readonly isPinned: number;
  readonly sidebarSortOrder: number;
  readonly createdAt: string;
}

function orderThreadSiblings(rows: readonly ThreadSiblingRow[]): ThreadSiblingRow[] {
  return [...rows].sort((left, right) => {
    const byPinned = right.isPinned - left.isPinned;
    if (byPinned !== 0) return byPinned;
    const byManual = left.sidebarSortOrder - right.sidebarSortOrder;
    if (byManual !== 0) return byManual;
    const byCreated = right.createdAt.localeCompare(left.createdAt);
    return byCreated || left.id.localeCompare(right.id);
  });
}

/** Inserts the moved row into the ordered siblings, or null if the drop is stale. */
function resolveThreadMoveOrder(
  destination: readonly ThreadSiblingRow[],
  moved: ThreadSiblingRow,
  position: ThreadMovePosition,
): ThreadSiblingRow[] | null {
  const others = orderThreadSiblings(destination);
  let insertionIndex = others.filter((row) => row.isPinned === 1).length;
  if (position.type === "after") {
    const anchorIndex = others.findIndex((row) => row.id === position.itemId);
    if (anchorIndex < 0) return null;
    if (others[anchorIndex]!.isPinned !== moved.isPinned) return null;
    insertionIndex = anchorIndex + 1;
  }
  const ordered = [...others];
  ordered.splice(insertionIndex, 0, moved);
  return ordered;
}

/** Pin/unpin. Returns true when the row changed (so the caller broadcasts). */
export const setThreadPinned = (input: {
  readonly threadId: string;
  readonly isPinned: boolean;
  readonly updatedAt: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const next = input.isPinned ? 1 : 0;
    const rows = yield* sql<{ readonly isPinned: number }>`
      SELECT is_pinned AS "isPinned" FROM threads WHERE id = ${input.threadId}
    `;
    if (rows[0] === undefined || rows[0].isPinned === next) return false;
    yield* sql`UPDATE threads SET is_pinned = ${next}, updated_at = ${input.updatedAt} WHERE id = ${input.threadId}`;
    return true;
  });

/** Mark visited. Returns true when the row changed. */
export const markThreadVisited = (input: {
  readonly threadId: string;
  readonly visitedAt: string;
  readonly updatedAt: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly lastVisitedAt: string | null }>`
      SELECT last_visited_at AS "lastVisitedAt" FROM threads WHERE id = ${input.threadId}
    `;
    if (rows[0] === undefined || rows[0].lastVisitedAt === input.visitedAt) return false;
    yield* sql`UPDATE threads SET last_visited_at = ${input.visitedAt}, updated_at = ${input.updatedAt} WHERE id = ${input.threadId}`;
    return true;
  });

/** Set runtime mode. Returns true when the row changed. */
export const setThreadRuntimeMode = (input: {
  readonly threadId: string;
  readonly runtimeMode: string;
  readonly updatedAt: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly runtimeMode: string }>`
      SELECT runtime_mode AS "runtimeMode" FROM threads WHERE id = ${input.threadId}
    `;
    if (rows[0] === undefined || rows[0].runtimeMode === input.runtimeMode) return false;
    yield* sql`UPDATE threads SET runtime_mode = ${input.runtimeMode}, updated_at = ${input.updatedAt} WHERE id = ${input.threadId}`;
    return true;
  });

/** Set working directory. Returns true when the row changed. */
export const setThreadWorkingDirectory = (input: {
  readonly threadId: string;
  readonly workingDirectory: string | null;
  readonly updatedAt: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly workingDirectory: string | null }>`
      SELECT working_directory AS "workingDirectory" FROM threads WHERE id = ${input.threadId}
    `;
    if (rows[0] === undefined || rows[0].workingDirectory === input.workingDirectory) return false;
    yield* sql`UPDATE threads SET working_directory = ${input.workingDirectory}, updated_at = ${input.updatedAt} WHERE id = ${input.threadId}`;
    return true;
  });

/**
 * Move/reorder a thread in a folder's sidebar. Renumbers every sibling's
 * `sidebar_sort_order` (and the moved thread's `folder_id`) in one transaction
 * and returns the changed thread ids for the caller to broadcast. Repeating the
 * same layout writes nothing.
 */
export const moveSidebarItem = (input: {
  readonly threadId: string;
  readonly folderId: string;
  readonly position: ThreadMovePosition;
  readonly updatedAt: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const movedRows = yield* sql<ThreadSiblingRow & { readonly folderId: string }>`
      SELECT id, folder_id AS "folderId", is_pinned AS "isPinned",
             COALESCE(sidebar_sort_order, 0) AS "sidebarSortOrder", created_at AS "createdAt"
      FROM threads WHERE id = ${input.threadId} AND deleted_at IS NULL
    `;
    const moved = movedRows[0];
    if (moved === undefined) return [] as string[];
    const destination = yield* sql<ThreadSiblingRow>`
      SELECT id, is_pinned AS "isPinned",
             COALESCE(sidebar_sort_order, 0) AS "sidebarSortOrder", created_at AS "createdAt"
      FROM threads
      WHERE folder_id = ${input.folderId} AND id != ${input.threadId}
        AND deleted_at IS NULL AND parent_thread_id IS NULL
    `;
    const ordered = resolveThreadMoveOrder(destination, moved, input.position);
    if (ordered === null) return [] as string[];
    const changed: string[] = [];
    for (let index = 0; index < ordered.length; index += 1) {
      const row = ordered[index]!;
      const folderChanged = row.id === input.threadId && moved.folderId !== input.folderId;
      const orderChanged = row.sidebarSortOrder !== index;
      if (!folderChanged && !orderChanged) continue;
      yield* sql`
        UPDATE threads SET sidebar_sort_order = ${index}, folder_id = ${input.folderId}, updated_at = ${input.updatedAt}
        WHERE id = ${row.id}
      `;
      changed.push(row.id);
    }
    return changed;
  });

/**
 * Reorder a thread within its deck. Renumbers `deck_sort_order` for the deck's
 * threads in one transaction and returns the changed thread ids.
 */
export const moveDeckThread = (input: {
  readonly threadId: string;
  readonly deckId: string;
  readonly position: ThreadMovePosition;
  readonly updatedAt: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const movedRows = yield* sql<ThreadSiblingRow & { readonly deckId: string | null }>`
      SELECT id, deck_id AS "deckId", is_pinned AS "isPinned",
             COALESCE(deck_sort_order, 0) AS "sidebarSortOrder", created_at AS "createdAt"
      FROM threads WHERE id = ${input.threadId} AND deleted_at IS NULL
    `;
    const moved = movedRows[0];
    if (moved === undefined) return [] as string[];
    const destination = yield* sql<ThreadSiblingRow>`
      SELECT id, is_pinned AS "isPinned",
             COALESCE(deck_sort_order, 0) AS "sidebarSortOrder", created_at AS "createdAt"
      FROM threads
      WHERE deck_id = ${input.deckId} AND id != ${input.threadId} AND deleted_at IS NULL
    `;
    const ordered = resolveThreadMoveOrder(destination, moved, input.position);
    if (ordered === null) return [] as string[];
    const changed: string[] = [];
    for (let index = 0; index < ordered.length; index += 1) {
      const row = ordered[index]!;
      const deckChanged = row.id === input.threadId && moved.deckId !== input.deckId;
      const orderChanged = row.sidebarSortOrder !== index;
      if (!deckChanged && !orderChanged) continue;
      yield* sql`
        UPDATE threads SET deck_sort_order = ${index}, deck_id = ${input.deckId}, updated_at = ${input.updatedAt}
        WHERE id = ${row.id}
      `;
      changed.push(row.id);
    }
    return changed;
  });

/** Answering a question updates the same row in place. */
export const answerQuestion = (
  threadId: string,
  sourceId: string,
  answerData: string,
  answeredAt: string,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE thread_items
      SET status = 'answered', data = ${answerData}, updated_at = ${answeredAt}
      WHERE thread_id = ${threadId} AND source_id = ${sourceId}
    `;
  });

/**
 * A turn's outcome is the only thing that settles its still-running items (TODO
 * 2.3): when the turn ends, or the provider exits / startup cuts off a running
 * thread, every `running` item of that turn becomes terminal in the same write.
 * No reconciler, no UI inference from turn state.
 */
export const settleRunningItems = (
  threadId: string,
  status: string,
  at: string,
  turnId?: string | null,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (turnId === undefined || turnId === null) {
      yield* sql`
        UPDATE thread_items
        SET status = ${status}, updated_at = ${at}
        WHERE thread_id = ${threadId} AND status = 'running'
      `;
    } else {
      yield* sql`
        UPDATE thread_items
        SET status = ${status}, updated_at = ${at}
        WHERE thread_id = ${threadId} AND status = 'running' AND turn_id = ${turnId}
      `;
    }
  });

/**
 * Streaming delta: append to the item's text, creating it on first delta.
 * `seq` is assigned once, as for the upsert.
 */
export const appendThreadItemText = (
  threadId: string,
  sourceId: string,
  kind: "text" | "reasoning" | "tool",
  delta: string,
  at: string,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO thread_items (
        thread_id, seq, source_id, turn_id, kind, status, text, data, created_at, updated_at
      ) VALUES (
        ${threadId},
        (SELECT COALESCE(MAX(seq), 0) + 1 FROM thread_items WHERE thread_id = ${threadId}),
        ${sourceId}, NULL, ${kind}, 'streaming', ${delta}, NULL, ${at}, ${at}
      )
      ON CONFLICT (thread_id, source_id) DO UPDATE SET
        text = COALESCE(thread_items.text, '') || excluded.text,
        status = 'streaming',
        updated_at = excluded.updated_at
    `;
  });
