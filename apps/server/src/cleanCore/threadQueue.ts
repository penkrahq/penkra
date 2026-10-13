// FILE: threadQueue.ts
// Purpose: The clean-core send queue and steer decision (0.14.4 design 2.4).
// One FIFO per thread, persisted as threads.queue JSON so it survives restart.
// Layer: Server clean core
// Exports: QueuedMessage, planSend, readThreadQueue, enqueueMessage

import type { CleanCoreSendMessageInput } from "@penkra/contracts";
import { nextCommittedDraftTimestamp } from "./threadDraftTimestamp.ts";
import { draftAfterSend } from "./threadDraft.ts";
import { Schema, Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export { CleanCoreQueuedMessage as QueuedMessage } from "@penkra/contracts";
import { CleanCoreQueuedMessage as QueuedMessage } from "@penkra/contracts";
export type SendPlan = "deliver" | "queue" | "steer" | "interrupt-deliver";

/**
 * Pure send decision. "now" (steer) uses the provider's native steering when it
 * supports it, otherwise interrupts and delivers this message first. A plain
 * send delivers while idle and queues while a turn is running.
 */
export function planSend(input: {
  readonly state: "idle" | "running" | "error";
  readonly dispatchMode: "queue" | "steer";
  readonly supportsSteer: boolean;
  readonly queueLength: number;
}): SendPlan {
  if (input.dispatchMode === "steer" && input.state === "running") {
    return input.supportsSteer ? "steer" : "interrupt-deliver";
  }
  return input.state === "running" || input.queueLength > 0 ? "queue" : "deliver";
}

const decodeQueue = Schema.decodeUnknownSync(Schema.Array(QueuedMessage));

export const readThreadQueue = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly queue: string | null }>`
      SELECT queue FROM threads WHERE id = ${threadId}
    `;
    if (rows[0] === undefined) return yield* Effect.fail(new Error("The thread does not exist."));
    return decodeQueue(JSON.parse(rows[0].queue!));
  });

export const enqueueMessage = (
  threadId: string,
  message: QueuedMessage,
  selection?: Pick<CleanCoreSendMessageInput, "modelSelection" | "connectionId" | "runtimeMode">,
  sentDraftUpdatedAt?: string | null,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly queue: string | null;
      readonly draft: string | null;
      readonly provider: string;
      readonly draftUpdatedAt: string | null;
    }>`
      SELECT queue, draft, provider, draft_updated_at AS "draftUpdatedAt" FROM threads WHERE id = ${threadId}
    `;
    const queue = [...decodeQueue(JSON.parse(rows[0]!.queue!)), message];
    const thread = rows[0]!;
    const changedAt = new Date().toISOString();
    if (sentDraftUpdatedAt !== undefined && thread.draftUpdatedAt === sentDraftUpdatedAt) {
      const draft = draftAfterSend(thread.draft, thread.provider, selection);
      const draftUpdatedAt = nextCommittedDraftTimestamp(thread.draftUpdatedAt, changedAt);
      yield* sql`UPDATE threads SET queue=${JSON.stringify(queue)},draft=${draft},draft_updated_at=${draftUpdatedAt},updated_at=${changedAt} WHERE id=${threadId}`;
    } else {
      yield* sql`UPDATE threads SET queue=${JSON.stringify(queue)},updated_at=${changedAt} WHERE id=${threadId}`;
    }
    return queue;
  });
