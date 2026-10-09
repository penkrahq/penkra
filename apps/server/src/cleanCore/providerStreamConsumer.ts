// FILE: providerStreamConsumer.ts
// Purpose: The clean-core provider stream consumer (0.14.4 design 2.3): turn
// state comes only from the provider stream, items go through the single
// thread_items upsert, and a provider exit cuts off whatever it was running.
// Layer: Server clean core
// Exports: CleanCoreProviderEvent, PROVIDER_CUTOFF_NOTICE, applyProviderEvent

import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  setThreadState,
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
      readonly type: "provider.exited";
      readonly threadIds: ReadonlyArray<string>;
      readonly at: string;
    };

export const PROVIDER_CUTOFF_NOTICE = "This turn was cut off because the provider stopped.";

/**
 * Apply one ordered provider event. Turn state is set only here — never
 * repaired from a reconciler — and every item write goes through the single
 * upsert, so replayed events are idempotent.
 */
export const applyProviderEvent = (publisher: ThreadPublisher, event: CleanCoreProviderEvent) =>
  Effect.gen(function* () {
    switch (event.type) {
      case "turn.started": {
        yield* setThreadState(event.threadId, "running", event.turnId, null, event.at);
        publisher.publish({ threadId: event.threadId });
        return;
      }
      case "turn.ended": {
        yield* setThreadState(
          event.threadId,
          event.state === "error" ? "error" : "idle",
          null,
          event.state === "error" ? (event.error ?? "Turn failed") : null,
          event.at,
        );
        publisher.publish({ threadId: event.threadId });
        return;
      }
      case "item": {
        yield* upsertThreadItem(event.item);
        publisher.publish({ threadId: event.threadId });
        return;
      }
      case "provider.exited": {
        yield* Effect.forEach(
          event.threadIds,
          (threadId) =>
            Effect.gen(function* () {
              yield* setThreadState(threadId, "idle", null, null, event.at);
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
              publisher.publish({ threadId });
            }),
          { discard: true },
        );
        return;
      }
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
