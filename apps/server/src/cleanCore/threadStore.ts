// FILE: threadStore.ts
// Purpose: The clean-core write path — idempotent thread/thread_items writes and
// the in-memory per-thread change publisher (0.14.4 design 2.1/2.2).
// Layer: Server persistence (clean core)
// Exports: makeThreadPublisher, upsertThreadItem, createThread, setThreadArchived,
//   renameThread, setThreadDeleted, setThreadState, updateThreadDraft, answerQuestion,
//   settleRunningItems

import {
  FolderId,
  SpaceId,
  ThreadId,
  type CleanCoreDeckMovePosition,
  type CleanCoreSidebarChange,
} from "@penkra/contracts";
import { normalizeEntityName } from "@penkra/shared/entityNames";
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
  readonly subscribeSidebar: (listener: (change: CleanCoreSidebarChange) => void) => () => void;
  readonly publishSidebar: (change: CleanCoreSidebarChange) => void;
}

export const makeThreadPublisher = (): ThreadPublisher => {
  const byThread = new Map<string, Set<(change: ThreadChange) => void>>();
  const all = new Set<(change: ThreadChange) => void>();
  const sidebar = new Set<(change: CleanCoreSidebarChange) => void>();
  return {
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
export type ThreadMovePosition =
  | { readonly type: "before" | "after"; readonly itemId: string }
  | { readonly type: "pinned-boundary" };

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
  if (position.type !== "pinned-boundary") {
    const anchorIndex = others.findIndex((row) => row.id === position.itemId);
    if (anchorIndex < 0) return null;
    if (others[anchorIndex]!.isPinned !== moved.isPinned) return null;
    insertionIndex = anchorIndex + (position.type === "after" ? 1 : 0);
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
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const next = input.isPinned ? 1 : 0;
        const rows = yield* sql<{ readonly isPinned: number }>`
      SELECT is_pinned AS "isPinned" FROM threads WHERE id = ${input.threadId}
    `;
        if (rows[0] === undefined || rows[0].isPinned === next) return false;
        yield* sql`UPDATE threads SET is_pinned = ${next}, sidebar_sort_order = 0, updated_at = ${input.updatedAt} WHERE id = ${input.threadId}`;
        return true;
      }),
    );
  });

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

/** Set working directory. Returns true when the row changed. */
export const setThreadWorkingDirectory = (input: {
  readonly threadId: string;
  readonly workingDirectory: string | null;
  readonly updatedAt: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly workingDirectory: string | null }>`
      SELECT working_directory AS "workingDirectory" FROM threads WHERE id = ${input.threadId}
    `;
        if (rows[0] === undefined || rows[0].workingDirectory === input.workingDirectory)
          return false;
        const items =
          yield* sql`SELECT seq FROM thread_items WHERE thread_id = ${input.threadId} LIMIT 1`;
        if (items.length !== 0)
          return yield* Effect.fail(
            new Error("A thread's physical folder cannot change after the thread has started."),
          );
        yield* sql`UPDATE threads SET working_directory = ${input.workingDirectory}, updated_at = ${input.updatedAt} WHERE id = ${input.threadId}`;
        return true;
      }),
    );
  });

/** A cross-space move must preserve singleton deck ownership. */
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
      readonly deckId: string | null;
    }>`
      SELECT space_id AS "spaceId", folder_id AS "folderId", deck_id AS "deckId"
      FROM threads WHERE id = ${input.threadId} AND deleted_at IS NULL`;
    const row = rows[0];
    if (row === undefined || (row.spaceId === input.spaceId && row.folderId === input.folderId))
      return false;
    if (row.spaceId !== input.spaceId && row.deckId !== null) {
      const other = yield* sql`SELECT id FROM threads WHERE deck_id = ${row.deckId}
        AND id != ${input.threadId} AND deleted_at IS NULL LIMIT 1`;
      if (other.length !== 0)
        return yield* Effect.fail(
          new Error("Threads in a multi-thread deck cannot be moved to another space."),
        );
      yield* sql`UPDATE projection_thread_decks SET space_id = ${input.spaceId}, updated_at = ${input.updatedAt}
        WHERE deck_id = ${row.deckId}`;
    }
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
      SELECT id, folder_id AS "folderId", is_pinned AS "isPinned",
             COALESCE(sidebar_sort_order, 0) AS "sidebarSortOrder", created_at AS "createdAt"
      FROM threads WHERE id = ${input.threadId} AND deleted_at IS NULL AND archived_at IS NULL AND parent_thread_id IS NULL
    `;
        const moved = movedRows[0];
        if (moved === undefined) return [] as string[];
        const destination: ThreadSiblingRow[] = [];
        let after: string | null = null;
        while (true) {
          const page: readonly ThreadSiblingRow[] = yield* sql<ThreadSiblingRow>`
            SELECT id, is_pinned AS "isPinned", COALESCE(sidebar_sort_order, 0) AS "sidebarSortOrder", created_at AS "createdAt"
            FROM threads WHERE folder_id = ${input.folderId} AND id != ${input.threadId}
              AND deleted_at IS NULL AND archived_at IS NULL AND parent_thread_id IS NULL
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
        if (moved.folderId !== input.folderId) {
          const treeIds = [input.threadId];
          for (const parentId of treeIds) {
            let afterChild: string | null = null;
            while (true) {
              const children: readonly { readonly id: string }[] = yield* sql<{
                readonly id: string;
              }>`
                SELECT id FROM threads WHERE parent_thread_id = ${parentId} AND deleted_at IS NULL
                  AND (${afterChild} IS NULL OR id > ${afterChild}) ORDER BY id LIMIT 50`;
              for (const child of children) {
                if (treeIds.includes(child.id)) continue;
                treeIds.push(child.id);
                if (
                  yield* relocateThread({
                    threadId: child.id,
                    folderId: input.folderId,
                    spaceId: folder.spaceId,
                    updatedAt: input.updatedAt,
                  })
                )
                  changed.push(child.id);
              }
              if (children.length < 50) break;
              afterChild = children[children.length - 1]!.id;
            }
          }
        }
        return changed;
      }),
    );
  });

/**
 * Reorder a thread within its deck. Renumbers `deck_sort_order` for the deck's
 * threads in one transaction and returns the changed thread ids.
 */
export const moveDeckThread = (input: {
  readonly threadId: string;
  readonly deckId: string;
  readonly position: CleanCoreDeckMovePosition;
  readonly updatedAt: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const movedRows = yield* sql<{
          readonly id: string;
          readonly deckId: string | null;
          readonly spaceId: string;
          readonly order: number;
          readonly createdAt: string;
        }>`
      SELECT id, deck_id AS "deckId", space_id AS "spaceId", deck_sort_order AS "order", created_at AS "createdAt"
      FROM threads WHERE id = ${input.threadId} AND deleted_at IS NULL AND archived_at IS NULL`;
        const moved = movedRows[0];
        if (moved === undefined) return [] as string[];
        const destinationDeck = yield* sql<{ readonly spaceId: string }>`
      SELECT space_id AS "spaceId" FROM projection_thread_decks WHERE deck_id = ${input.deckId}`;
        if (destinationDeck[0] !== undefined && destinationDeck[0].spaceId !== moved.spaceId) {
          return yield* Effect.fail(
            new Error("Threads cannot move between decks in different spaces."),
          );
        }
        const readSiblings = (deckId: string | null) =>
          Effect.gen(function* () {
            const siblings: {
              readonly id: string;
              readonly order: number;
              readonly createdAt: string;
            }[] = [];
            let after: string | null = null;
            while (true) {
              const page: readonly {
                readonly id: string;
                readonly order: number;
                readonly createdAt: string;
              }[] = yield* sql<{
                readonly id: string;
                readonly order: number;
                readonly createdAt: string;
              }>`
          SELECT id, deck_sort_order AS "order", created_at AS "createdAt" FROM threads
          WHERE deck_id IS ${deckId} AND id != ${input.threadId} AND deleted_at IS NULL
            AND (${after} IS NULL OR id > ${after}) ORDER BY id LIMIT 50`;
              siblings.push(...page);
              if (page.length < 50) break;
              after = page[page.length - 1]!.id;
            }
            return siblings.sort(
              (left, right) =>
                left.order - right.order ||
                left.createdAt.localeCompare(right.createdAt) ||
                left.id.localeCompare(right.id),
            );
          });
        const ordered = yield* readSiblings(input.deckId);
        const position = input.position;
        let insertionIndex = position.type === "start" ? 0 : ordered.length;
        if (position.type === "before" || position.type === "after") {
          const anchor = ordered.findIndex((row) => row.id === position.itemId);
          if (anchor < 0) return [] as string[];
          insertionIndex = anchor + (position.type === "after" ? 1 : 0);
        }
        ordered.splice(insertionIndex, 0, moved);
        const changed: string[] = [];
        for (let index = 0; index < ordered.length; index += 1) {
          const row = ordered[index]!;
          if (row.order === index && (row.id !== moved.id || moved.deckId === input.deckId))
            continue;
          yield* sql`UPDATE threads SET deck_id = ${input.deckId}, deck_sort_order = ${index},
        updated_at = ${input.updatedAt} WHERE id = ${row.id}`;
          changed.push(row.id);
        }
        if (changed.length === 0) return changed;
        yield* sql`INSERT INTO projection_thread_decks (deck_id, space_id, created_at, updated_at)
      VALUES (${input.deckId}, ${moved.spaceId}, ${input.updatedAt}, ${input.updatedAt})
      ON CONFLICT(deck_id) DO UPDATE SET updated_at = excluded.updated_at`;
        if (moved.deckId !== input.deckId) {
          const source = yield* readSiblings(moved.deckId);
          for (let index = 0; index < source.length; index += 1) {
            const row = source[index]!;
            if (row.order === index) continue;
            yield* sql`UPDATE threads SET deck_sort_order = ${index}, updated_at = ${input.updatedAt} WHERE id = ${row.id}`;
            changed.push(row.id);
          }
          if (source.length === 0) {
            yield* sql`DELETE FROM projection_thread_decks WHERE deck_id IS ${moved.deckId}`;
          }
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
      SELECT folder_id AS id, title, space_id AS "spaceId", is_pinned AS "isPinned",
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
        SELECT folder_id AS id, title, is_pinned AS "isPinned", sidebar_sort_order AS "sidebarSortOrder",
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

/** Reorder active spaces in one transaction. Spaces have no pin partition. */
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
        let insertionIndex = 0;
        if (input.position.type !== "pinned-boundary") {
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

/** Publish committed folder and space rows; no event journal or projection replay. */
export const publishSidebarRows = (
  publisher: ThreadPublisher,
  kind: "folder" | "space",
  ids: readonly string[],
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const id of ids) {
      if (kind === "folder") {
        const rows = yield* sql<{
          readonly spaceId: string;
          readonly sidebarSortOrder: number;
          readonly updatedAt: string;
        }>`
          SELECT space_id AS "spaceId", sidebar_sort_order AS "sidebarSortOrder", updated_at AS "updatedAt"
          FROM projection_folders WHERE folder_id = ${id}`;
        const row = rows[0];
        if (row !== undefined)
          publisher.publishSidebar({
            kind,
            folderId: FolderId.makeUnsafe(id),
            spaceId: SpaceId.makeUnsafe(row.spaceId),
            sidebarSortOrder: row.sidebarSortOrder,
            updatedAt: row.updatedAt,
          });
      } else {
        const rows = yield* sql<{ readonly sortOrder: number; readonly updatedAt: string }>`
          SELECT sort_order AS "sortOrder", updated_at AS "updatedAt" FROM projection_spaces WHERE space_id = ${id}`;
        const row = rows[0];
        if (row !== undefined)
          publisher.publishSidebar({ kind, spaceId: SpaceId.makeUnsafe(id), ...row });
      }
    }
  });
