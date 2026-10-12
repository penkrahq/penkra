// FILE: threadList.ts
// Purpose: The clean-core thread-list read (0.14.4 step 4): one bounded,
// indexed, keyset-paged query over `threads` that the sidebar, folder tabs and
// ChatView read instead of the old projection snapshot.
// Layer: Server clean core
// Exports: ThreadSummaryRecord, ThreadListCursor, listThreads

import type {
  CleanCoreSearchThreadsInput,
  CleanCoreThreadSearchCursor,
  FolderId,
  ProviderConnectionId,
  SpaceId,
  ThreadId,
  TurnId,
} from "@penkra/contracts";
import { THREADS_PAGE_SIZE } from "@penkra/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export interface ThreadSummaryRecord {
  readonly id: ThreadId;
  readonly spaceId: SpaceId;
  readonly folderId: FolderId;
  readonly title: string;
  readonly provider: string;
  readonly connectionId: ProviderConnectionId | null;
  readonly model: string;
  readonly modelOptions: string | null;
  readonly runtimeMode: string;
  readonly state: string;
  readonly activeTurnId: TurnId | null;
  readonly lastError: string | null;
  readonly queue: string;
  readonly createdBy: string;
  readonly createdByThreadId: ThreadId | null;
  readonly sidebarSortOrder: number | null;
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

export const THREAD_SUMMARY_COLUMNS = `
        id,
        space_id AS "spaceId",
        folder_id AS "folderId",
        title,
        provider,
        connection_id AS "connectionId",
        model,
        model_options AS "modelOptions",
        runtime_mode AS "runtimeMode",
        state,
        active_turn_id AS "activeTurnId",
        last_error AS "lastError",
        queue,
        created_by AS "createdBy",
        created_by_thread_id AS "createdByThreadId",
        sidebar_sort_order AS "sidebarSortOrder",
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
/** The sidebar order key: manual order, then newest. */
export interface ThreadListCursor {
  readonly sidebarSortOrder: number;
  readonly createdAt: string;
  readonly id: ThreadId;
}

export interface ThreadListPage {
  readonly threads: ReadonlyArray<ThreadSummaryRecord>;
  readonly nextCursor: ThreadListCursor | null;
}

/**
 * One (space, folder) page of threads in the sidebar order, bounded by a
 * keyset cursor. Deleted rows are excluded in SQL. The index
 * `idx_threads_sidebar_order` matches this exact order.
 */
interface ThreadPageInput {
  readonly spaceId: SpaceId;
  readonly folderId: FolderId | null;
  readonly after?: ThreadListCursor | null | undefined;
  readonly limit?: number | undefined;
}
const readThreadPage = (input: ThreadPageInput, includeArchived: boolean) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const limit = input.limit ?? THREADS_PAGE_SIZE;
    const after = input.after ?? null;
    const hasAfter = after === null ? 0 : 1;
    const afterOrder = after?.sidebarSortOrder ?? null;
    const afterCreatedAt = after?.createdAt ?? null;
    const afterId = after?.id ?? null;
    const rows = yield* sql<ThreadSummaryRecord>`
      SELECT ${sql.literal(THREAD_SUMMARY_COLUMNS)}
      FROM threads
      WHERE space_id = ${input.spaceId}
        AND folder_id IS ${input.folderId}
        AND deleted_at IS NULL
        AND (${includeArchived ? 1 : 0} = 1 OR archived_at IS NULL)
        AND (
          ${hasAfter} = 0
          OR COALESCE(sidebar_sort_order, 0) > ${afterOrder}
          OR (
            COALESCE(sidebar_sort_order, 0) = ${afterOrder}
            AND created_at < ${afterCreatedAt}
          )
          OR (
            COALESCE(sidebar_sort_order, 0) = ${afterOrder}
            AND created_at = ${afterCreatedAt}
            AND id > ${afterId}
          )
        )
      ORDER BY COALESCE(sidebar_sort_order, 0) ASC, created_at DESC, id ASC
      LIMIT ${limit + 1}
    `;
    const pageRows = rows.length > limit ? rows.slice(0, limit) : rows;
    const last = pageRows.at(-1);
    return {
      threads: pageRows,
      nextCursor:
        rows.length > limit && last !== undefined
          ? {
              sidebarSortOrder: last.sidebarSortOrder ?? 0,
              createdAt: last.createdAt,
              id: last.id,
            }
          : null,
    } satisfies ThreadListPage;
  });

export const listThreads = (input: ThreadPageInput) => readThreadPage(input, true);
/** Folder API pages omit archived rows and use the same sidebar keyset order. */
export const listFolderThreads = (input: Omit<ThreadPageInput, "limit">) =>
  readThreadPage(input, false);

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

export interface ThreadSearchMatch extends ThreadSummaryRecord {
  readonly matchKind: "title" | "message";
  readonly messageId: string | null;
  readonly messageText: string | null;
}

/** Space-wide search with the latest matching transcript item and a keyset page. */
export const searchThreads = (input: CleanCoreSearchThreadsInput) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const cursor = input.cursor;
    // Quote the user's text as an FTS phrase, rather than interpreting FTS operators.
    const phrase = '"' + input.query.replaceAll('"', '""') + '"';
    const rows = yield* sql<ThreadSearchMatch>`
      WITH message_hits AS (
        SELECT i.thread_id, i.source_id, i.text,
          ROW_NUMBER() OVER (PARTITION BY i.thread_id ORDER BY i.seq DESC) AS position
        FROM thread_items_search JOIN thread_items i ON i.rowid = thread_items_search.rowid
        JOIN threads t ON t.id = i.thread_id
        WHERE thread_items_search MATCH ${phrase}
          AND i.kind != 'turn'
          AND t.space_id = ${input.spaceId} AND t.archived_at IS NULL AND t.deleted_at IS NULL
      ), candidates AS (
        SELECT t.*,
          CASE WHEN instr(lower(t.title), lower(${input.query})) > 0 THEN 'title' ELSE 'message' END AS matchKind,
          CASE WHEN instr(lower(t.title), lower(${input.query})) > 0 THEN 0 ELSE 1 END AS match_order,
          CASE WHEN instr(lower(t.title), lower(${input.query})) > 0 THEN NULL ELSE m.source_id END AS messageId,
          CASE WHEN instr(lower(t.title), lower(${input.query})) > 0 THEN NULL ELSE m.text END AS messageText
        FROM threads t LEFT JOIN message_hits m ON m.thread_id = t.id AND m.position = 1
        WHERE t.space_id = ${input.spaceId} AND t.archived_at IS NULL AND t.deleted_at IS NULL
          AND (instr(lower(t.title), lower(${input.query})) > 0 OR m.source_id IS NOT NULL)
      )
      SELECT ${sql.literal(THREAD_SUMMARY_COLUMNS)}, matchKind, messageId, messageText FROM candidates
      WHERE (${cursor === null ? 0 : 1} = 0
        OR match_order > ${cursor === null ? null : cursor.matchKind === "title" ? 0 : 1}
        OR (matchKind = ${cursor?.matchKind ?? null} AND (
          last_activity_at < ${cursor?.lastActivityAt ?? null}
          OR (last_activity_at IS NULL AND ${cursor?.lastActivityAt ?? null} IS NOT NULL)
          OR (last_activity_at IS ${cursor?.lastActivityAt ?? null} AND id > ${cursor?.id ?? null})
        )))
      ORDER BY match_order ASC, last_activity_at DESC, id ASC
      LIMIT ${THREADS_PAGE_SIZE + 1}
    `;
    const threads = rows.slice(0, THREADS_PAGE_SIZE);
    const last = threads.at(-1);
    const nextCursor: CleanCoreThreadSearchCursor | null =
      rows.length > THREADS_PAGE_SIZE && last !== undefined
        ? { matchKind: last.matchKind, lastActivityAt: last.lastActivityAt, id: last.id }
        : null;
    return { threads, nextCursor };
  });

export const RUNNING_THREADS_SQL = `SELECT ${THREAD_SUMMARY_COLUMNS} FROM threads WHERE state = 'running' AND deleted_at IS NULL AND archived_at IS NULL ORDER BY id`;
export const listRunningThreads = () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.unsafe<ThreadSummaryRecord>(RUNNING_THREADS_SQL);
  });
