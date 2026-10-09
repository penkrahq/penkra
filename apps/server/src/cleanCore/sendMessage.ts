// FILE: sendMessage.ts
// Purpose: The clean-core send path (0.14.4 design 2.4). Decides deliver vs
// queue with planSend, inserts the user item on delivery, and queues otherwise.
// Layer: Server clean core
// Exports: sendMessage

import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PROVIDER_CUTOFF_NOTICE } from "./providerStreamConsumer.ts";
import { enqueueMessage, planSend, type QueuedMessage, type SendPlan } from "./threadQueue.ts";
import { upsertThreadItem, type ThreadPublisher } from "./threadStore.ts";

/** The prompt the manual "play" button sends to resume a cut-off thread. */
export const PLAY_TURN_RECOVERY_PROMPT =
  "The previous turn did not finish. Continue the existing task from the current state. Verify the current state before repeating any action whose outcome may be uncertain.";

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
      const data =
        input.message.senderThreadId !== undefined || input.message.dispatchOrigin !== undefined
          ? JSON.stringify({
              ...(input.message.senderThreadId !== undefined
                ? { senderThreadId: input.message.senderThreadId }
                : {}),
              ...(input.message.dispatchOrigin !== undefined
                ? { dispatchOrigin: input.message.dispatchOrigin }
                : {}),
            })
          : null;
      yield* upsertThreadItem({
        threadId: input.threadId,
        sourceId: input.message.sourceId,
        kind: "user",
        status: "sent",
        text: input.message.text,
        data,
        createdAt: input.message.at,
        updatedAt: input.message.at,
      });
    }
    publisher.publish({ threadId: input.threadId });
    return plan;
  });

/**
 * The manual "play" button: resume a cut-off thread by sending the recovery
 * prompt as a real user message through the normal send path. Only an idle
 * thread that carries the provider cut-off notice can be resumed; returns the
 * prompt when it started, or null when there was nothing to resume.
 */
export const playThread = (
  publisher: ThreadPublisher,
  input: { readonly threadId: string; readonly messageSourceId: string; readonly at: string },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly state: string }>`
      SELECT state FROM threads WHERE id = ${input.threadId}
    `;
    if (rows[0]?.state !== "idle") return null;
    const cutoff = yield* sql<{ readonly present: number }>`
      SELECT 1 AS present FROM thread_items
      WHERE thread_id = ${input.threadId} AND kind = 'notice' AND text = ${PROVIDER_CUTOFF_NOTICE}
      LIMIT 1
    `;
    if (cutoff.length === 0) return null;
    yield* sendMessage(publisher, {
      threadId: input.threadId,
      message: { sourceId: input.messageSourceId, text: PLAY_TURN_RECOVERY_PROMPT, at: input.at },
      dispatchMode: "queue",
      supportsSteer: false,
    });
    return PLAY_TURN_RECOVERY_PROMPT;
  });
