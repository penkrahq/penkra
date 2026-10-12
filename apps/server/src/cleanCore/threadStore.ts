// FILE: threadStore.ts
// Purpose: The clean-core write path — idempotent thread/thread_items writes and
// the in-memory per-thread change publisher (0.14.4 design 2.1/2.2).
// Layer: Server persistence (clean core)
// Exports: makeThreadPublisher, upsertThreadItem, createThread, setThreadArchived,
//   renameThread, setThreadDeleted, setThreadState, updateThreadDraft, answerQuestion,
//   settleRunningItems

import { ThreadId, type CleanCoreSidebarChange } from "@penkra/contracts";
import { normalizeEntityName } from "@penkra/shared/entityNames";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { CleanCoreProviderEvent } from "./providerStreamConsumer.ts";
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

export type MessageDispatchReply = { readonly threadId: string; readonly messageId: string } & (
  | { readonly type: "acknowledged"; readonly turnId: string }
  | { readonly type: "failed"; readonly error: string }
);

export interface ThreadPublisher {
  readonly subscribeProvider: (listener: (event: CleanCoreProviderEvent) => void) => () => void;
  readonly publishProvider: (event: CleanCoreProviderEvent) => void;
  readonly subscribeDispatch: (
    threadId: string,
    messageId: string,
    listener: (reply: MessageDispatchReply) => void,
  ) => () => void;
  readonly publishDispatch: (reply: MessageDispatchReply) => void;
  /** Subscribe to one thread's changes. Returns an unsubscribe function. */
  readonly subscribe: (threadId: string, listener: (change: ThreadChange) => void) => () => void;
  /** Subscribe to every thread's changes. Returns an unsubscribe function. */
  readonly subscribeAll: (listener: (change: ThreadChange) => void) => () => void;
  readonly publish: (change: ThreadChange) => void;
  readonly publishCreated: (change: ThreadChange) => void;
  readonly subscribeSidebar: (listener: (change: CleanCoreSidebarChange) => void) => () => void;
  readonly publishSidebar: (change: CleanCoreSidebarChange) => void;
}

export const makeThreadPublisher = (): ThreadPublisher => {
  const byThread = new Map<string, Set<(change: ThreadChange) => void>>();
  const all = new Set<(change: ThreadChange) => void>();
  const sidebar = new Set<(change: CleanCoreSidebarChange) => void>();
  const provider = new Set<(event: CleanCoreProviderEvent) => void>();
  const dispatch = new Set<(reply: MessageDispatchReply) => void>();
  return {
    subscribeProvider: (listener) => {
      provider.add(listener);
      return () => {
        provider.delete(listener);
      };
    },
    publishProvider: (event) => {
      for (const listener of provider) listener(event);
    },
    subscribeDispatch: (threadId, messageId, listener) => {
      const scoped = (reply: MessageDispatchReply) => {
        if (reply.threadId === threadId && reply.messageId === messageId) listener(reply);
      };
      dispatch.add(scoped);
      return () => {
        dispatch.delete(scoped);
      };
    },
    publishDispatch: (reply) => {
      for (const listener of dispatch) listener(reply);
    },
    subscribeSidebar: (listener) => {
      sidebar.add(listener);
      return () => {
        sidebar.delete(listener);
      };
    },
    publishSidebar: (change) => {
      for (const listener of sidebar) listener(change);
    },
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
    publishCreated: (change) => {
      for (const listener of byThread.get(change.threadId) ?? []) listener(change);
      for (const listener of all) listener(change);
      for (const listener of sidebar)
        listener({ kind: "thread.created", threadId: ThreadId.makeUnsafe(change.threadId) });
    },
    publish: (change) => {
      for (const listener of byThread.get(change.threadId) ?? []) listener(change);
      for (const listener of all) listener(change);
      for (const listener of sidebar)
        listener({ kind: "thread", threadId: ThreadId.makeUnsafe(change.threadId) });
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
  readonly folderId: string;
  readonly title: string;
  readonly provider: string;
  readonly connectionId?: string | null;
  readonly model: string;
  readonly modelOptions?: string | null;
  readonly runtimeMode: string;
  readonly providerSessionId?: string | null;
  readonly nativeStateId?: string | null;
  readonly sidebarSortOrder?: number | null;
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
        runtime_mode, provider_session_id, native_state_id, state,
        queue, created_by, created_by_thread_id, sidebar_sort_order, created_at, updated_at
      ) VALUES (
        ${input.id}, ${input.spaceId}, ${input.folderId}, ${input.title},
        ${input.provider}, ${input.connectionId ?? null}, ${input.model},
        ${input.modelOptions ?? null}, ${input.runtimeMode},
        ${input.providerSessionId ?? null},
        ${input.nativeStateId ?? null}, 'idle', '[]', ${input.createdBy},
        ${input.createdByThreadId ?? null},
        ${input.sidebarSortOrder ?? null},
        ${input.createdAt}, ${input.createdAt}
      )
    `;
  });

const updateThreadLifecycleColumn = (
  id: string,
  column: "archived_at" | "deleted_at" | "title",
  value: string | null,
  updatedAt: string,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows =
      column === "archived_at"
        ? yield* sql`UPDATE threads SET archived_at = ${value}, updated_at = ${updatedAt} WHERE id = ${id} AND deleted_at IS NULL AND ((archived_at IS NULL AND ${value} IS NOT NULL) OR (archived_at IS NOT NULL AND ${value} IS NULL)) RETURNING id`
        : column === "deleted_at"
          ? yield* sql`UPDATE threads SET deleted_at = ${value}, updated_at = ${updatedAt} WHERE id = ${id} AND deleted_at IS NULL RETURNING id`
          : yield* sql`UPDATE threads SET title = ${value}, updated_at = ${updatedAt} WHERE id = ${id} AND deleted_at IS NULL AND title IS NOT ${value} RETURNING id`;
    return rows.length !== 0;
  });

export class ThreadRunningError extends Error {
  readonly code = "thread_running";
  constructor() {
    super("This thread is still running. Stop it before archiving.");
  }
}

export const setThreadArchived = (
  id: string,
  archivedAt: string | null,
  updatedAt: string,
  expected: { updatedAt: string; lastVisitedAt: string | null } | null,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        if (expected !== null) {
          const changed =
            yield* sql`UPDATE threads SET archived_at=${archivedAt}, updated_at=${updatedAt} WHERE id=${id} AND archived_at IS NULL AND deleted_at IS NULL AND updated_at=${expected.updatedAt} AND last_visited_at IS ${expected.lastVisitedAt} AND state NOT IN ('starting','running') AND active_turn_id IS NULL AND open_question_count=0 RETURNING id`;
          return changed.length !== 0;
        }
        const rows = yield* sql<{
          state: string;
          archivedAt: string | null;
          deletedAt: string | null;
        }>`SELECT state, archived_at AS "archivedAt", deleted_at AS "deletedAt" FROM threads WHERE id = ${id}`;
        const row = rows[0];
        if (
          row === undefined ||
          row.deletedAt !== null ||
          (row.archivedAt === null) === (archivedAt === null)
        )
          return false;
        if (archivedAt !== null && row.state === "running")
          return yield* Effect.fail(new ThreadRunningError());
        return yield* updateThreadLifecycleColumn(id, "archived_at", archivedAt, updatedAt);
      }),
    );
  });
export const setThreadDeleted = (id: string, deletedAt: string, updatedAt: string) =>
  updateThreadLifecycleColumn(id, "deleted_at", deletedAt, updatedAt);
export const renameThread = (id: string, title: string, updatedAt: string) =>
  updateThreadLifecycleColumn(id, "title", title, updatedAt);

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
/** A sidebar drop position: before/after a sibling, or the start/end of the list. */
export type ThreadMovePosition =
  | { readonly type: "before" | "after"; readonly itemId: string }
  | { readonly type: "start" | "end" };
interface ThreadSiblingRow {
  readonly id: string;
  readonly sidebarSortOrder: number;
  readonly createdAt: string;
}

function orderThreadSiblings(rows: readonly ThreadSiblingRow[]): ThreadSiblingRow[] {
  return [...rows].sort((left, right) => {
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
  let insertionIndex = position.type === "end" ? others.length : 0;
  if (position.type === "before" || position.type === "after") {
    const anchorIndex = others.findIndex((row) => row.id === position.itemId);
    if (anchorIndex < 0) return null;
    insertionIndex = anchorIndex + (position.type === "after" ? 1 : 0);
  }
  const ordered = [...others];
  ordered.splice(insertionIndex, 0, moved);
  return ordered;
}
/** Mark visited. Returns true when the row changed. */
export const markThreadVisited = (input: {
  readonly threadId: string;
  readonly visitedAt: string;
  readonly updatedAt: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly lastVisitedAt: string | null }>`
      SELECT last_visited_at AS "lastVisitedAt" FROM threads WHERE id = ${input.threadId}
    `;
        if (rows[0] === undefined || rows[0].lastVisitedAt === input.visitedAt) return false;
        yield* sql`UPDATE threads SET last_visited_at = ${input.visitedAt}, updated_at = ${input.updatedAt} WHERE id = ${input.threadId}`;
        yield* sql`INSERT OR IGNORE INTO retention_active_days (day_utc, first_seen_at) VALUES (${new Date(input.visitedAt).toISOString().slice(0, 10)}, ${input.visitedAt})`;
        return true;
      }),
    );
  });

/** Set runtime mode. Returns true when the row changed. */
export const setThreadRuntimeMode = (input: {
  readonly threadId: string;
  readonly runtimeMode: string;
  readonly updatedAt: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly runtimeMode: string }>`
      SELECT runtime_mode AS "runtimeMode" FROM threads WHERE id = ${input.threadId}
    `;
        if (rows[0] === undefined || rows[0].runtimeMode === input.runtimeMode) return false;
        yield* sql`UPDATE threads SET runtime_mode = ${input.runtimeMode}, updated_at = ${input.updatedAt} WHERE id = ${input.threadId}`;
        return true;
      }),
    );
  });

/** Relocate the row to its destination folder and space. */
const relocateThread = (input: {
  threadId: string;
  folderId: string;
  spaceId: string;
  updatedAt: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly spaceId: string;
      readonly folderId: string | null;
    }>`
      SELECT space_id AS "spaceId", folder_id AS "folderId"
      FROM threads WHERE id = ${input.threadId} AND deleted_at IS NULL`;
    const row = rows[0];
    if (row === undefined || (row.spaceId === input.spaceId && row.folderId === input.folderId))
      return false;
    yield* sql`UPDATE threads SET folder_id = ${input.folderId}, space_id = ${input.spaceId},
      updated_at = ${input.updatedAt} WHERE id = ${input.threadId}`;
    return true;
  });

const listThreadIdsInFolder = (folderId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const ids: string[] = [];
    let after: string | null = null;
    while (true) {
      const page: readonly { readonly id: string }[] = yield* sql<{ readonly id: string }>`
      SELECT id FROM threads WHERE folder_id = ${folderId} AND deleted_at IS NULL
        AND (${after} IS NULL OR id > ${after}) ORDER BY id LIMIT 50`;
      ids.push(...page.map((row) => row.id));
      if (page.length < 50) break;
      after = page[page.length - 1]!.id;
    }
    return ids;
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
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const folders = yield* sql<{ readonly spaceId: string }>`SELECT space_id AS "spaceId"
          FROM projection_folders WHERE folder_id = ${input.folderId} AND deleted_at IS NULL`;
        const folder = folders[0];
        if (folder === undefined) return [] as string[];
        const movedRows = yield* sql<ThreadSiblingRow & { readonly folderId: string }>`
      SELECT id, folder_id AS "folderId",
             COALESCE(sidebar_sort_order, 0) AS "sidebarSortOrder", created_at AS "createdAt"
      FROM threads WHERE id = ${input.threadId} AND deleted_at IS NULL AND archived_at IS NULL
    `;
        const moved = movedRows[0];
        if (moved === undefined) return [] as string[];
        const destination: ThreadSiblingRow[] = [];
        let after: string | null = null;
        while (true) {
          const page: readonly ThreadSiblingRow[] = yield* sql<ThreadSiblingRow>`
            SELECT id, COALESCE(sidebar_sort_order, 0) AS "sidebarSortOrder", created_at AS "createdAt"
            FROM threads WHERE folder_id = ${input.folderId} AND id != ${input.threadId}
              AND deleted_at IS NULL AND archived_at IS NULL
              AND (${after} IS NULL OR id > ${after}) ORDER BY id LIMIT 50`;
          destination.push(...page);
          if (page.length < 50) break;
          after = page[page.length - 1]!.id;
        }
        const ordered = resolveThreadMoveOrder(destination, moved, input.position);
        if (ordered === null) return [] as string[];
        const changed: string[] = [];
        for (let index = 0; index < ordered.length; index += 1) {
          const row = ordered[index]!;
          const folderChanged = row.id === input.threadId && moved.folderId !== input.folderId;
          const orderChanged = row.sidebarSortOrder !== index;
          if (row.id === input.threadId && folderChanged) {
            yield* relocateThread({
              threadId: row.id,
              folderId: input.folderId,
              spaceId: folder.spaceId,
              updatedAt: input.updatedAt,
            });
          }
          if (!folderChanged && !orderChanged) continue;
          yield* sql`
        UPDATE threads SET sidebar_sort_order = ${index}, folder_id = ${input.folderId}, updated_at = ${input.updatedAt}
        WHERE id = ${row.id}
      `;
          changed.push(row.id);
        }
        return changed;
      }),
    );
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
 * thread, every running/streaming item of that turn becomes interrupted in the same write.
 * No reconciler, no UI inference from turn state.
 */
export const settleRunningItems = (threadId: string, at: string, turnId?: string | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (turnId === undefined || turnId === null) {
      yield* sql`
        UPDATE thread_items
        SET status = 'interrupted', updated_at = ${at}
        WHERE thread_id = ${threadId} AND status IN ('running', 'streaming')
      `;
    } else {
      yield* sql`
        UPDATE thread_items
        SET status = 'interrupted', updated_at = ${at}
        WHERE thread_id = ${threadId} AND status IN ('running', 'streaming')
          AND (turn_id = ${turnId} OR turn_id IS NULL)
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

/** Move a folder into a space and renumber the destination in one transaction. */
export const moveFolder = (input: {
  readonly folderId: string;
  readonly spaceId: string;
  readonly position: ThreadMovePosition;
  readonly updatedAt: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const spaces =
          yield* sql`SELECT space_id FROM projection_spaces WHERE space_id = ${input.spaceId}
          AND deleted_at IS NULL AND archived_at IS NULL`;
        if (spaces.length === 0)
          return yield* Effect.fail(new Error("The destination space does not exist."));
        const movedRows = yield* sql<
          ThreadSiblingRow & { readonly spaceId: string; readonly title: string }
        >`
      SELECT folder_id AS id, title, space_id AS "spaceId",
        sidebar_sort_order AS "sidebarSortOrder", created_at AS "createdAt"
      FROM projection_folders WHERE folder_id = ${input.folderId} AND deleted_at IS NULL
    `;
        const moved = movedRows[0];
        if (moved === undefined) return { folderIds: [], threadIds: [] };
        const destination: (ThreadSiblingRow & { readonly title: string })[] = [];
        let after: string | null = null;
        while (true) {
          const page: readonly (ThreadSiblingRow & { readonly title: string })[] = yield* sql<
            ThreadSiblingRow & { readonly title: string }
          >`
        SELECT folder_id AS id, title, sidebar_sort_order AS "sidebarSortOrder",
          created_at AS "createdAt" FROM projection_folders
        WHERE space_id = ${input.spaceId} AND folder_id != ${input.folderId} AND deleted_at IS NULL
          AND (${after} IS NULL OR folder_id > ${after}) ORDER BY folder_id LIMIT 50
      `;
          destination.push(...page);
          if (page.length < 50) break;
          after = page[page.length - 1]!.id;
        }
        if (
          moved.spaceId !== input.spaceId &&
          destination.some(
            (row) => normalizeEntityName(row.title) === normalizeEntityName(moved.title),
          )
        ) {
          return yield* Effect.fail(
            new Error(`A folder named '${moved.title}' already exists in this space.`),
          );
        }
        const ordered = resolveThreadMoveOrder(destination, moved, input.position);
        if (ordered === null) return { folderIds: [], threadIds: [] };
        const changed: string[] = [];
        for (let index = 0; index < ordered.length; index += 1) {
          const row = ordered[index]!;
          if (
            row.sidebarSortOrder === index &&
            (row.id !== input.folderId || moved.spaceId === input.spaceId)
          )
            continue;
          yield* sql`UPDATE projection_folders SET sidebar_sort_order = ${index}, space_id = ${input.spaceId},
        updated_at = ${input.updatedAt} WHERE folder_id = ${row.id}`;
          changed.push(row.id);
        }
        const threadIds: string[] = [];
        if (moved.spaceId !== input.spaceId) {
          for (const threadId of yield* listThreadIdsInFolder(input.folderId)) {
            if (
              yield* relocateThread({
                threadId,
                folderId: input.folderId,
                spaceId: input.spaceId,
                updatedAt: input.updatedAt,
              })
            )
              threadIds.push(threadId);
          }
        }
        return { folderIds: changed, threadIds };
      }),
    );
  });
/** Reorder active spaces in one transaction. */
export const moveSpace = (input: {
  readonly spaceId: string;
  readonly position: ThreadMovePosition;
  readonly updatedAt: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows: {
          readonly id: string;
          readonly sortOrder: number;
          readonly createdAt: string;
        }[] = [];
        let after: string | null = null;
        while (true) {
          const page: readonly {
            readonly id: string;
            readonly sortOrder: number;
            readonly createdAt: string;
          }[] = yield* sql<{
            readonly id: string;
            readonly sortOrder: number;
            readonly createdAt: string;
          }>`
        SELECT space_id AS id, sort_order AS "sortOrder", created_at AS "createdAt" FROM projection_spaces
        WHERE deleted_at IS NULL AND archived_at IS NULL AND (${after} IS NULL OR space_id > ${after})
        ORDER BY space_id LIMIT 50
      `;
          rows.push(...page);
          if (page.length < 50) break;
          after = page[page.length - 1]!.id;
        }
        rows.sort(
          (left, right) =>
            left.sortOrder - right.sortOrder ||
            left.createdAt.localeCompare(right.createdAt) ||
            left.id.localeCompare(right.id),
        );
        const moved = rows.find((row) => row.id === input.spaceId);
        if (moved === undefined) return [] as string[];
        const ordered = rows.filter((row) => row.id !== input.spaceId);
        let insertionIndex = input.position.type === "end" ? ordered.length : 0;
        if (input.position.type === "before" || input.position.type === "after") {
          const anchorId = input.position.itemId;
          const anchor = ordered.findIndex((row) => row.id === anchorId);
          if (anchor < 0) return [] as string[];
          insertionIndex = anchor + (input.position.type === "after" ? 1 : 0);
        }
        ordered.splice(insertionIndex, 0, moved);
        const changed: string[] = [];
        for (let index = 0; index < ordered.length; index += 1) {
          const row = ordered[index]!;
          if (row.sortOrder === index) continue;
          yield* sql`UPDATE projection_spaces SET sort_order = ${index}, updated_at = ${input.updatedAt}
        WHERE space_id = ${row.id}`;
          changed.push(row.id);
        }
        return changed;
      }),
    );
  });
