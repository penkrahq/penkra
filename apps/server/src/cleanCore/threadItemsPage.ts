// FILE: threadItemsPage.ts
// Purpose: The clean-core bounded transcript read (0.14.4 design 2.1):
// `WHERE thread_id=? AND seq<? ORDER BY seq DESC LIMIT 50`, newest first, with
// a seq cursor. No query scans items across threads.
// Layer: Server clean core
// Exports: ThreadItemRow, ThreadItemsPage, listThreadItemsPage

import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export interface ThreadItemRow {
  readonly threadId: string;
  readonly seq: number;
  readonly sourceId: string;
  readonly turnId: string | null;
  readonly kind: string;
  readonly status: string;
  readonly text: string | null;
  readonly data: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ThreadItemsPage {
  /** Newest first. */
  readonly items: ReadonlyArray<ThreadItemRow>;
  /** Pass as `beforeSeq` to read the next older page, or null when exhausted. */
  readonly nextCursor: number | null;
}

export const THREAD_ITEMS_PAGE_SIZE = 50;

export const listThreadItemsPage = (input: {
  readonly threadId: string;
  readonly beforeSeq?: number;
  readonly limit?: number;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const limit = input.limit ?? THREAD_ITEMS_PAGE_SIZE;
    const before = input.beforeSeq ?? null;
    const rows = yield* sql<ThreadItemRow>`
      SELECT
        thread_id AS "threadId",
        seq,
        source_id AS "sourceId",
        turn_id AS "turnId",
        kind,
        status,
        text,
        data,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM thread_items
      WHERE thread_id = ${input.threadId}
        AND (${before} IS NULL OR seq < ${before})
      ORDER BY seq DESC
      LIMIT ${limit}
    `;
    const oldest = rows.at(-1);
    return {
      items: rows,
      nextCursor: rows.length === limit && oldest !== undefined ? oldest.seq : null,
    } satisfies ThreadItemsPage;
  });
