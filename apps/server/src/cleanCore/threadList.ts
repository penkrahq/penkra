// FILE: threadList.ts
// Purpose: The clean-core thread-list read (0.14.4 step 4): one bounded,
// indexed, keyset-paged query over `threads` that the sidebar, the deck and
// ChatView read instead of the old projection snapshot.
// Layer: Server clean core
// Exports: ThreadSummaryRecord, ThreadListCursor, listThreads, THREADS_PAGE_SIZE

import type {
  FolderId,
  ProviderConnectionId,
  SpaceId,
  ThreadDeckId,
  ThreadId,
  TurnId,
} from "@penkra/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export interface ThreadSummaryRecord {
  readonly id: ThreadId;
  readonly spaceId: SpaceId;
  readonly folderId: FolderId | null;
  readonly title: string;
  readonly provider: string;
  readonly connectionId: ProviderConnectionId | null;
  readonly model: string;
  readonly modelOptions: string | null;
  readonly runtimeMode: string;
  readonly workingDirectory: string | null;
  readonly state: string;
  readonly activeTurnId: TurnId | null;
  readonly lastError: string | null;
  readonly queue: string;
  readonly createdBy: string;
  readonly createdByThreadId: ThreadId | null;
  readonly parentThreadId: ThreadId | null;
  readonly deckId: ThreadDeckId | null;
  readonly deckSortOrder: number;
  readonly sidebarSortOrder: number | null;
  readonly isPinned: number;
  readonly lastActivityAt: string | null;
  readonly lastMessagePreview: string | null;
  readonly lastUserMessageAt: string | null;
  readonly lastVisitedAt: string | null;
  readonly openQuestionCount: number;
  readonly archivedAt: string | null;
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const THREAD_SUMMARY_COLUMNS = `
        id,
        space_id AS "spaceId",
        folder_id AS "folderId",
        title,
        provider,
        connection_id AS "connectionId",
        model,
        model_options AS "modelOptions",
        runtime_mode AS "runtimeMode",
        working_directory AS "workingDirectory",
        state,
        active_turn_id AS "activeTurnId",
        last_error AS "lastError",
        queue,
        created_by AS "createdBy",
        created_by_thread_id AS "createdByThreadId",
        parent_thread_id AS "parentThreadId",
        deck_id AS "deckId",
        deck_sort_order AS "deckSortOrder",
        sidebar_sort_order AS "sidebarSortOrder",
        is_pinned AS "isPinned",
        last_activity_at AS "lastActivityAt",
        last_message_preview AS "lastMessagePreview",
        last_user_message_at AS "lastUserMessageAt",
        last_visited_at AS "lastVisitedAt",
        open_question_count AS "openQuestionCount",
        archived_at AS "archivedAt",
        deleted_at AS "deletedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
`;

/** The sidebar order key: pinned first, then manual order, then newest. */
export interface ThreadListCursor {
  readonly isPinned: number;
  readonly sidebarSortOrder: number;
  readonly createdAt: string;
  readonly id: ThreadId;
}

export interface ThreadListPage {
  readonly threads: ReadonlyArray<ThreadSummaryRecord>;
  readonly nextCursor: ThreadListCursor | null;
}

/** 50 = one screen with margin (2.1). */
export const THREADS_PAGE_SIZE = 50;

/**
 * One (space, folder) page of threads in the sidebar order, bounded by a
 * keyset cursor. Deleted rows are excluded in SQL. The index
 * `idx_threads_sidebar_order` matches this exact order.
 */
export const listThreads = (input: {
  readonly spaceId: SpaceId;
  readonly folderId: FolderId | null;
  readonly after?: ThreadListCursor | null | undefined;
  readonly limit?: number | undefined;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const limit = input.limit ?? THREADS_PAGE_SIZE;
    const after = input.after ?? null;
    const hasAfter = after === null ? 0 : 1;
    const afterPinned = after?.isPinned ?? null;
    const afterOrder = after?.sidebarSortOrder ?? null;
    const afterCreatedAt = after?.createdAt ?? null;
    const afterId = after?.id ?? null;
    const rows = yield* sql<ThreadSummaryRecord>`
      SELECT ${sql.literal(THREAD_SUMMARY_COLUMNS)}
      FROM threads
      WHERE space_id = ${input.spaceId}
        AND folder_id IS ${input.folderId}
        AND deleted_at IS NULL
        AND (
          ${hasAfter} = 0
          OR is_pinned < ${afterPinned}
          OR (
            is_pinned = ${afterPinned}
            AND COALESCE(sidebar_sort_order, 0) > ${afterOrder}
          )
          OR (
            is_pinned = ${afterPinned}
            AND COALESCE(sidebar_sort_order, 0) = ${afterOrder}
            AND created_at < ${afterCreatedAt}
          )
          OR (
            is_pinned = ${afterPinned}
            AND COALESCE(sidebar_sort_order, 0) = ${afterOrder}
            AND created_at = ${afterCreatedAt}
            AND id > ${afterId}
          )
        )
      ORDER BY is_pinned DESC, COALESCE(sidebar_sort_order, 0) ASC, created_at DESC, id ASC
      LIMIT ${limit + 1}
    `;
    const pageRows = rows.length > limit ? rows.slice(0, limit) : rows;
    const last = pageRows.at(-1);
    return {
      threads: pageRows,
      nextCursor:
        rows.length > limit && last !== undefined
          ? {
              isPinned: last.isPinned,
              sidebarSortOrder: last.sidebarSortOrder ?? 0,
              createdAt: last.createdAt,
              id: last.id,
            }
          : null,
    } satisfies ThreadListPage;
  });

/** Indexed single-row read for creation and publisher consumers. */
export const findThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<ThreadSummaryRecord>`
      SELECT ${sql.literal(THREAD_SUMMARY_COLUMNS)}
      FROM threads
      WHERE id = ${threadId}
  `;
    return rows[0] === undefined ? null : rows[0];
  });

export const getThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const row = yield* findThread(threadId);
    if (row === null) return yield* Effect.fail(new Error("The thread does not exist."));
    return row;
  });

/** Indexed deck membership, independent of whichever sidebar pages are loaded. */
export const listDeckThreads = (input: {
  readonly deckId: ThreadDeckId;
  readonly after: { readonly deckSortOrder: number; readonly id: ThreadId } | null;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<ThreadSummaryRecord>`
      SELECT ${sql.literal(THREAD_SUMMARY_COLUMNS)}
      FROM threads
      WHERE deck_id = ${input.deckId}
        AND deleted_at IS NULL
        AND (${input.after === null ? 0 : 1} = 0
          OR deck_sort_order > ${input.after?.deckSortOrder ?? null}
          OR (deck_sort_order = ${input.after?.deckSortOrder ?? null}
            AND id > ${input.after?.id ?? null}))
      ORDER BY deck_sort_order ASC, id ASC
      LIMIT ${THREADS_PAGE_SIZE}
    `;
    const last = rows.at(-1);
    return {
      threads: rows,
      nextCursor:
        rows.length === THREADS_PAGE_SIZE && last !== undefined
          ? { deckSortOrder: last.deckSortOrder, id: last.id }
          : null,
    };
  });
