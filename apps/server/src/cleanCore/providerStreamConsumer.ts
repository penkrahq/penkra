import { ProviderAuthCircuits } from "../provider/providerAuthCircuit.ts";
import { classifyProviderAuthFailure } from "../provider/providerAuthFailure.ts";
import { renameThread } from "./threadStore.ts";
// FILE: providerStreamConsumer.ts
// Purpose: The clean-core provider stream consumer (0.14.4 design 2.3): turn
// state comes only from the provider stream, items go through the single
// thread_items upsert, and a provider exit cuts off whatever it was running.
// Layer: Server clean core
// Exports: CleanCoreProviderEvent, PROVIDER_CUTOFF_NOTICE, applyProviderEvent

import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type ProviderRuntimeEvent,
} from "@penkra/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { failSendingMessagesOnStartup, writeSendingMessageFailures } from "./sendMessage.ts";
import { toCleanCoreProviderEvents } from "./providerEventBridge.ts";
import { writeProviderConnectionFacts } from "./providerConnectionFacts.ts";
import { threadItemActivityData } from "./threadItemData.ts";

import {
  answerQuestion,
  appendThreadItemText,
  appendToolOutput,
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
      readonly turnId?: string | null;
      readonly sourceId: string;
      readonly kind: "text" | "tool";
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
      readonly type: "provider.exited" | "provider.failed";
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
        yield* upsertThreadItem({
          threadId: event.threadId,
          sourceId: `turn:${event.turnId}`,
          turnId: event.turnId,
          kind: "turn",
          status: "running",
          data: JSON.stringify({ startedAt: event.at, endedAt: null }),
          createdAt: event.at,
          updatedAt: event.at,
        });
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
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE thread_items
          SET status = ${event.state === "completed" ? "done" : event.state},
              data = json_set(data, '$.endedAt', ${event.at}), updated_at = ${event.at}
          WHERE thread_id = ${event.threadId} AND source_id = ${`turn:${event.turnId}`} AND kind = 'turn'`;
        // The turn's outcome settles its still-running items in the same write.
        yield* settleRunningItems(event.threadId, event.at, event.turnId);
        if (event.state === "error")
          yield* writeSendingMessageFailures(
            event.threadId,
            event.error ?? "Turn failed",
            event.at,
          );
        return [event.threadId];
      }
      case "item": {
        // Admission is the only user-item writer. Native echoes neither create nor replace user rows.
        if (event.item.kind === "user") return [];
        yield* upsertThreadItem(event.item);
        return [event.threadId];
      }
      case "delta": {
        yield* event.kind === "tool"
          ? appendToolOutput(event.threadId, event.sourceId, event.delta, event.at, event.turnId)
          : appendThreadItemText(
              event.threadId,
              event.sourceId,
              event.kind,
              event.delta,
              event.at,
              event.turnId,
            );
        return [event.threadId];
      }
      case "question.answered": {
        yield* answerQuestion(event.threadId, event.sourceId, event.answerData, event.at);
        return [event.threadId];
      }
      case "provider.failed":
      case "provider.exited": {
        const changedThreadIds = yield* Effect.forEach(event.threadIds, (threadId) =>
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const [thread] = yield* sql<{
              state: string;
              provider: ProviderKind;
            }>`SELECT state, provider FROM threads WHERE id=${threadId}`;
            if (!thread) return [];
            const reason = event.reason ?? PROVIDER_CUTOFF_NOTICE;
            const failedSending = yield* writeSendingMessageFailures(threadId, reason, event.at);
            if (thread.state !== "running" && !failedSending) return [];
            yield* setThreadState(
              threadId,
              event.type === "provider.failed" || failedSending ? "error" : "idle",
              null,
              event.type === "provider.failed" || failedSending ? reason : null,
              event.at,
            );
            yield* settleRunningItems(threadId, event.at);
            if (event.type === "provider.exited" && thread.state === "running") {
              const summary = `${PROVIDER_DISPLAY_NAMES[thread.provider]} stopped before finishing`;
              yield* upsertThreadItem({
                threadId,
                sourceId: `provider-cutoff:${event.at}`,
                kind: "notice",
                status: "done",
                text: summary,
                data: threadItemActivityData({
                  tone: "info",
                  kind: "provider-stopped",
                  summary,
                  payload: {},
                }),
                createdAt: event.at,
                updatedAt: event.at,
              });
            }
            return [threadId];
          }),
        );
        return changedThreadIds.flat();
      }
    }
  });

/** Publish only committed row/item state; a failed write publishes nothing. */
const publishProviderEvent = (
  publisher: ThreadPublisher,
  event: CleanCoreProviderEvent,
  changedThreadIds: ReadonlyArray<string>,
) => {
  for (const threadId of changedThreadIds) publisher.publish({ threadId });
  if (
    event.type === "turn.started" ||
    event.type === "turn.ended" ||
    event.type === "provider.exited" ||
    event.type === "provider.failed"
  ) {
    publisher.publishProvider(event);
  }
};

export const applyProviderEvent = (publisher: ThreadPublisher, event: CleanCoreProviderEvent) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const changedThreadIds = yield* sql.withTransaction(writeProviderEvent(event));
    publishProviderEvent(publisher, event, changedThreadIds);
  });

/** A runtime event's usage, items and turn state commit before its broadcasts. */
export const applyProviderRuntimeEvent = (
  publisher: ThreadPublisher,
  event: ProviderRuntimeEvent,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const events = toCleanCoreProviderEvents(event);
    if (event.type === "runtime.warning")
      yield* Effect.logWarning("provider runtime warning", {
        threadId: event.threadId,
        provider: event.provider,
        message: event.payload.message,
      });
    for (const item of events) {
      if (
        (item.type === "item" && item.item.kind !== "user" && item.item.turnId == null) ||
        (item.type === "delta" && item.turnId == null)
      )
        yield* Effect.logWarning("provider item missing turn identity", {
          threadId: event.threadId,
          provider: event.provider,
          eventId: event.eventId,
          type: event.type,
        });
    }
    const changes = yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* writeProviderConnectionFacts(event);
        return yield* Effect.forEach(events, writeProviderEvent);
      }),
    );
    for (let index = 0; index < events.length; index++) {
      publishProviderEvent(publisher, events[index]!, changes[index]!);
    }
  });

/** Drain only the deltas already waiting, in order, with one commit and invalidation per thread. */
export const applyProviderDeltaRun = (
  publisher: ThreadPublisher,
  events: ReadonlyArray<ProviderRuntimeEvent>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    type Delta = Extract<CleanCoreProviderEvent, { type: "delta" }>;
    const runs: Array<{ event: Delta; parts: string[] }> = [];
    for (const runtimeEvent of events) {
      for (const event of toCleanCoreProviderEvents(runtimeEvent)) {
        if (event.type !== "delta") continue;
        const previous = runs.at(-1);
        if (
          previous &&
          previous.event.threadId === event.threadId &&
          previous.event.sourceId === event.sourceId &&
          previous.event.kind === event.kind
        ) {
          previous.parts.push(event.delta);
          previous.event = { ...event };
        } else runs.push({ event, parts: [event.delta] });
      }
    }
    if (runs.length === 0) return;
    for (const { event, parts } of runs) {
      if (event.turnId == null)
        yield* Effect.logWarning("provider delta run missing turn identity", {
          threadId: event.threadId,
          sourceId: event.sourceId,
          kind: event.kind,
          deltaCount: parts.length,
        });
    }
    const changed = new Set<string>();
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const { event, parts } of runs) {
          yield* writeProviderEvent({ ...event, delta: parts.join("") });
          changed.add(event.threadId);
        }
      }),
    );
    for (const threadId of changed) publisher.publish({ threadId });
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
    yield* failSendingMessagesOnStartup(publisher, at, PROVIDER_CUTOFF_NOTICE);
    if (rows.length === 0) return;
    yield* applyProviderEvent(publisher, {
      type: "provider.exited",
      threadIds: rows.map((row) => row.id),
      at,
    });
  });

/** The single production consumer: no second projection, persisted pump or swallowed write. */
export const consumeProviderRuntimeEvent = (
  publisher: ThreadPublisher,
  event: ProviderRuntimeEvent,
) =>
  Effect.gen(function* () {
    if (event.type === "runtime.error") {
      const circuits = yield* ProviderAuthCircuits;
      const connection = (yield* circuits.connectionForThread(event.threadId))[0];
      const failure = connection
        ? classifyProviderAuthFailure({
            detail: event.payload.message,
            authenticationMethodId: connection.authenticationMethodId,
          })
        : null;
      if (connection && failure)
        yield* circuits.open({
          connectionId: connection.connectionId,
          failure,
          now: event.createdAt,
        });
    }
    yield* applyProviderRuntimeEvent(publisher, event);
    if (event.type === "thread.metadata.updated" && event.payload.name) {
      if (yield* renameThread(event.threadId, event.payload.name, event.createdAt))
        publisher.publish({ threadId: event.threadId });
    }
  });
