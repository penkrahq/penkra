// FILE: threadStore.ts
// Purpose: The clean-core write path — idempotent thread/thread_items writes and
// the in-memory per-thread change publisher (0.14.4 design 2.1/2.2).
// Layer: Server persistence (clean core)
// Exports: makeThreadPublisher, upsertThreadItem, createThread, setThreadArchived,
//   renameThread, setThreadDeleted, setThreadState, updateThreadDraft, answerQuestion

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
  });

export interface CreateThreadInput {
  readonly id: string;
  readonly spaceId: string;
  readonly folderId?: string | null;
  readonly title: string;
  readonly provider: string;
  readonly connectionId?: string | null;
  readonly model: string;
  readonly modelOptions?: string | null;
  readonly providerSessionId?: string | null;
  readonly nativeStateId?: string | null;
  readonly createdAt: string;
}

/** Client-chosen id; a resend after a dropped connection changes nothing. */
export const createThread = (input: CreateThreadInput) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT OR IGNORE INTO threads (
        id, space_id, folder_id, title, provider, connection_id, model, model_options,
        provider_session_id, native_state_id, state, queue, created_at, updated_at
      ) VALUES (
        ${input.id}, ${input.spaceId}, ${input.folderId ?? null}, ${input.title},
        ${input.provider}, ${input.connectionId ?? null}, ${input.model},
        ${input.modelOptions ?? null}, ${input.providerSessionId ?? null},
        ${input.nativeStateId ?? null}, 'idle', '[]', ${input.createdAt}, ${input.createdAt}
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
