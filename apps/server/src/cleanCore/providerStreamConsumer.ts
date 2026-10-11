// FILE: providerStreamConsumer.ts
// Purpose: The clean-core provider stream consumer (0.14.4 design 2.3): turn
// state comes only from the provider stream, items go through the single
// thread_items upsert, and a provider exit cuts off whatever it was running.
// Layer: Server clean core
// Exports: CleanCoreProviderEvent, PROVIDER_CUTOFF_NOTICE, applyProviderEvent

import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  answerQuestion,
  appendThreadItemText,
  setThreadState,
  settleRunningItems,
  upsertThreadItem,
  type ThreadItemInput,
  type ThreadPublisher,
} from "./threadStore.ts";

export type CleanCoreProviderEvent =
  | {
      readonly type: "turn.started";
      readonly threadId: string;
      readonly turnId: string;
      readonly at: string;
    }
  | {
      readonly type: "turn.ended";
      readonly threadId: string;
      readonly turnId: string;
      readonly state: "completed" | "interrupted" | "error";
      readonly error?: string | null;
      readonly at: string;
    }
  | {
      readonly type: "item";
      readonly threadId: string;
      readonly item: ThreadItemInput;
    }
  | {
      readonly type: "delta";
      readonly threadId: string;
      readonly sourceId: string;
      readonly kind: "text" | "reasoning" | "tool";
      readonly delta: string;
      readonly at: string;
    }
  | {
      readonly type: "question.answered";
      readonly threadId: string;
      readonly sourceId: string;
      readonly answerData: string;
      readonly at: string;
    }
  | {
      readonly type: "provider.exited";
      readonly threadIds: ReadonlyArray<string>;
      readonly reason?: string;
      readonly at: string;
    };

export const PROVIDER_CUTOFF_NOTICE = "This turn was cut off because the provider stopped.";

/**
 * Write one ordered provider event. Turn state is set only here — never
 * repaired from a reconciler — and every item write goes through the single
 * upsert, so replayed events are idempotent.
 */
const writeProviderEvent = (event: CleanCoreProviderEvent) =>
  Effect.gen(function* () {
    switch (event.type) {
      case "turn.started": {
        yield* setThreadState(event.threadId, "running", event.turnId, null, event.at);
        return [event.threadId];
      }
      case "turn.ended": {
        yield* setThreadState(
          event.threadId,
          event.state === "error" ? "error" : "idle",
          null,
          event.state === "error" ? (event.error ?? "Turn failed") : null,
          event.at,
        );
        // The turn's outcome settles its still-running items in the same write.
        yield* settleRunningItems(
          event.threadId,
          event.state === "completed" ? "done" : event.state === "error" ? "error" : "interrupted",
          event.at,
          event.turnId,
        );
        return [event.threadId];
      }
      case "item": {
        yield* upsertThreadItem(event.item);
        return [event.threadId];
      }
      case "delta": {
        yield* appendThreadItemText(
          event.threadId,
          event.sourceId,
          event.kind,
          event.delta,
          event.at,
        );
        return [event.threadId];
      }
      case "question.answered": {
        yield* answerQuestion(event.threadId, event.sourceId, event.answerData, event.at);
        return [event.threadId];
      }
      case "provider.exited": {
        const changedThreadIds = yield* Effect.forEach(event.threadIds, (threadId) =>
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const rows =
              yield* sql`SELECT id FROM threads WHERE id = ${threadId} AND state = 'running'`;
            if (rows.length === 0) return [];
            yield* setThreadState(threadId, "idle", null, null, event.at);
            // A cut-off turn leaves no running items behind.
            yield* settleRunningItems(threadId, "interrupted", event.at);
            yield* upsertThreadItem({
              threadId,
              sourceId: `provider-cutoff:${event.at}`,
              kind: "notice",
              status: "done",
              text: PROVIDER_CUTOFF_NOTICE,
              data: null,
              createdAt: event.at,
              updatedAt: event.at,
            });
            return [threadId];
          }),
        );
        return changedThreadIds.flat();
      }
    }
  });

/** Publish only committed row/item state; a failed write publishes nothing. */
export const applyProviderEvent = (publisher: ThreadPublisher, event: CleanCoreProviderEvent) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const changedThreadIds = yield* sql.withTransaction(writeProviderEvent(event));
    for (const threadId of changedThreadIds) publisher.publish({ threadId });
    if (
      event.type === "turn.started" ||
      event.type === "turn.ended" ||
      event.type === "provider.exited"
    ) {
      publisher.publishProvider(event);
    }
  });

/**
 * Startup rule (2.3): no runtime survives a restart, so every thread still in
 * `running` is cut off. Each becomes `idle` and gets the same cut-off notice.
 * Idempotent: a second run at the same `at` changes nothing and adds no notice.
 */
export const settleRunningThreadsOnStartup = (publisher: ThreadPublisher, at: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly id: string }>`
      SELECT id FROM threads WHERE state = 'running'
    `;
    if (rows.length === 0) return;
    yield* applyProviderEvent(publisher, {
      type: "provider.exited",
      threadIds: rows.map((row) => row.id),
      at,
    });
  });
