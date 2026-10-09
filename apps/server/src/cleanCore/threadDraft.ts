// FILE: threadDraft.ts
// Purpose: The clean-core composer draft (0.14.4 design 2.6): one draft per
// thread on threads.draft, last write wins by draft_updated_at.
// Layer: Server clean core
// Exports: ThreadDraft, getThreadDraft, setThreadDraft

import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { updateThreadDraft } from "./threadStore.ts";

export interface ThreadDraft {
  readonly draft: string | null;
  readonly draftUpdatedAt: string | null;
}

export const getThreadDraft = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly draft: string | null; readonly updatedAt: string | null }>`
      SELECT draft, draft_updated_at AS "updatedAt" FROM threads WHERE id = ${threadId}
    `;
    return {
      draft: rows[0]?.draft ?? null,
      draftUpdatedAt: rows[0]?.updatedAt ?? null,
    } satisfies ThreadDraft;
  });

/**
 * Saves the draft; a write older than the stored draft_updated_at is ignored
 * (last write wins), so windows cannot clobber each other out of order.
 */
export const setThreadDraft = (threadId: string, draft: string | null, updatedAt: string) =>
  Effect.gen(function* () {
    yield* updateThreadDraft(threadId, draft, updatedAt);
    return yield* getThreadDraft(threadId);
  });
