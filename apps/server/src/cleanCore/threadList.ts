// FILE: threadList.ts
// Purpose: The clean-core thread-list read (0.14.4 step 4): one bounded query
// over `threads` that the sidebar, the deck and ChatView read instead of the
// old projection snapshot.
// Layer: Server clean core
// Exports: ThreadSummaryRecord, listThreads

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

/** Every thread row, including archived ones; the caller filters deleted rows. */
export const listThreads = () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<ThreadSummaryRecord>`
      SELECT
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
      FROM threads
      ORDER BY COALESCE(sidebar_sort_order, 0) ASC, COALESCE(last_activity_at, created_at) DESC, id ASC
    `;
  });
