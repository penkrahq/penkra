// FILE: threadItemsPage.ts
// Purpose: The clean-core bounded transcript read (0.14.4 design 2.1):
// `WHERE thread_id=? AND seq<? ORDER BY seq DESC LIMIT 50`, newest first, with
// a seq cursor. No query scans items across threads.
// Layer: Server clean core
// Exports: ThreadItemRecord, ThreadItemsPage, listThreadItemsPage

import type { ThreadId, TurnId, CleanCoreThreadItem } from "@penkra/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export interface ThreadItemRecord {
  readonly threadId: ThreadId;
  readonly seq: number;
  readonly sourceId: string;
  readonly turnId: TurnId | null;
  readonly kind: CleanCoreThreadItem["kind"];
  readonly status: string;
  readonly text: string | null;
  readonly data: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ThreadItemsPage extends ThreadItemRecordsPage {
  readonly finals: Readonly<Record<string, ThreadItemRecord>>;
  readonly hasSteps: Readonly<Record<string, boolean>>;
  readonly turns: Readonly<Record<string, ThreadItemRecord>>;
}

interface ThreadItemRecordsPage {
  /** Newest first. */
  readonly items: ReadonlyArray<ThreadItemRecord>;
  /** Pass as `beforeSeq` to read the next older page, or null when exhausted. */
  readonly nextCursor: number | null;
}

export const THREAD_ITEMS_PAGE_SIZE = 50;

interface PageInput {
  readonly threadId: ThreadId;
  readonly beforeSeq?: number | undefined;
  readonly limit?: number;
}

// Raw retained records serve agent reads and provider reconstruction, not the UI outline.
export const listThreadItemRecords = (input: PageInput) => readPage(input, false);

const readPage = (input: PageInput, outline: boolean) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const limit = input.limit ?? THREAD_ITEMS_PAGE_SIZE;
    const before = input.beforeSeq ?? null;
    const rows = yield* sql<ThreadItemRecord>`
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
        ${outline ? sql`AND (kind IN ('user','question','turn') OR turn_id IS NULL)` : sql``}
        AND (${before} IS NULL OR seq < ${before})
      ORDER BY seq DESC
      LIMIT ${limit}
    `;
    const oldest = rows.at(-1);
    return {
      items: rows,
      nextCursor: rows.length === limit && oldest !== undefined ? oldest.seq : null,
    } satisfies ThreadItemRecordsPage;
  });

const lastTurnText = (threadId: string, turnId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [final] =
      yield* sql<ThreadItemRecord>`SELECT thread_id AS "threadId",seq,source_id AS "sourceId",turn_id AS "turnId",kind,status,text,data,
    created_at AS "createdAt",updated_at AS "updatedAt" FROM thread_items INDEXED BY idx_thread_items_turn_text
    WHERE thread_id=${threadId} AND turn_id=${turnId} AND kind='text' ORDER BY seq DESC LIMIT 1`;
    return final;
  });

export const listThreadItemsPage = (input: PageInput) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const page = yield* readPage(input, true);
    const turns: Record<string, ThreadItemRecord> = {};
    const finals: Record<string, ThreadItemRecord> = {};
    const hasSteps: Record<string, boolean> = {};
    for (const turn of page.items) {
      if (turn.kind !== "turn" || turn.turnId === null) continue;
      turns[turn.turnId] = turn;
      const final = yield* lastTurnText(input.threadId, turn.turnId);
      if (final) finals[turn.turnId] = final;
      const seq = final?.seq ?? null;
      const [steps] = yield* sql<{
        present: number;
      }>`SELECT EXISTS(SELECT 1 FROM thread_items INDEXED BY idx_thread_items_turn_seq
      WHERE thread_id=${input.threadId} AND turn_id=${turn.turnId} AND kind NOT IN ('user','question','turn')
      AND (${seq} IS NULL OR seq<>${seq})) AS present`;
      hasSteps[turn.turnId] = Boolean(steps!.present);
    }
    return { ...page, turns, finals, hasSteps } satisfies ThreadItemsPage;
  });

export const listTurnItems = (input: PageInput & { readonly turnId: string }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const final = yield* lastTurnText(input.threadId, input.turnId);
    const finalSeq = final?.seq ?? null;
    const before = input.beforeSeq ?? null;
    const limit = input.limit ?? THREAD_ITEMS_PAGE_SIZE;
    const rows =
      yield* sql<ThreadItemRecord>`SELECT thread_id AS "threadId",seq,source_id AS "sourceId",turn_id AS "turnId",kind,status,text,data,
    created_at AS "createdAt",updated_at AS "updatedAt" FROM thread_items INDEXED BY idx_thread_items_turn_seq
    WHERE thread_id=${input.threadId} AND turn_id=${input.turnId} AND kind NOT IN ('user','question','turn')
      AND (${finalSeq} IS NULL OR seq<>${finalSeq}) AND (${before} IS NULL OR seq<${before}) ORDER BY seq DESC LIMIT ${limit}`;
    return {
      items: rows,
      nextCursor: rows.length === limit ? rows.at(-1)!.seq : null,
    } satisfies ThreadItemRecordsPage;
  });
