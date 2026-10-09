// FILE: sendMessage.ts
// Purpose: The clean-core send path (0.14.4 design 2.4). Decides deliver vs
// queue with planSend, inserts the user item on delivery, and queues otherwise.
// Layer: Server clean core
// Exports: sendMessage

import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { enqueueMessage, planSend, type QueuedMessage, type SendPlan } from "./threadQueue.ts";
import { upsertThreadItem, type ThreadPublisher } from "./threadStore.ts";

export interface SendMessageInput {
  readonly threadId: string;
  readonly message: QueuedMessage;
  readonly dispatchMode: "queue" | "steer";
  readonly supportsSteer: boolean;
}

/**
 * Decide and apply a send. Delivery (plain, steer or interrupt-deliver) inserts
 * the `user` item and returns the plan so the caller can drive the provider;
 * queueing only appends to the thread's FIFO. The user item is the transcript
 * record, so a steered message appears where and when it was delivered.
 */
export const sendMessage = (publisher: ThreadPublisher, input: SendMessageInput) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly state: "idle" | "running" | "error" }>`
      SELECT state FROM threads WHERE id = ${input.threadId}
    `;
    const state = rows[0]?.state ?? "idle";
    const plan: SendPlan = planSend({
      state,
      dispatchMode: input.dispatchMode,
      supportsSteer: input.supportsSteer,
    });
    if (plan === "queue") {
      yield* enqueueMessage(input.threadId, input.message);
    } else {
      yield* upsertThreadItem({
        threadId: input.threadId,
        sourceId: input.message.sourceId,
        kind: "user",
        status: "sent",
        text: input.message.text,
        data: null,
        createdAt: input.message.at,
        updatedAt: input.message.at,
      });
    }
    publisher.publish({ threadId: input.threadId });
    return plan;
  });
