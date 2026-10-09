// FILE: threadQueue.ts
// Purpose: The clean-core send queue and steer decision (0.14.4 design 2.4).
// One FIFO per thread, persisted as threads.queue JSON so it survives restart.
// Layer: Server clean core
// Exports: QueuedMessage, planSend, readThreadQueue, enqueueMessage, dequeueNextMessage

import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export interface QueuedMessage {
  /** The client-chosen id of the user message; also the future item source id. */
  readonly sourceId: string;
  readonly text: string;
  readonly at: string;
}

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
}): SendPlan {
  if (input.dispatchMode === "steer") {
    return input.supportsSteer ? "steer" : "interrupt-deliver";
  }
  return input.state === "running" ? "queue" : "deliver";
}

const decodeQueue = (value: string | null): ReadonlyArray<QueuedMessage> => {
  if (value === null) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as ReadonlyArray<QueuedMessage>) : [];
  } catch {
    return [];
  }
};

export const readThreadQueue = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly queue: string | null }>`
      SELECT queue FROM threads WHERE id = ${threadId}
    `;
    return decodeQueue(rows[0]?.queue ?? null);
  });

export const enqueueMessage = (threadId: string, message: QueuedMessage) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly queue: string | null }>`
      SELECT queue FROM threads WHERE id = ${threadId}
    `;
    const queue = [...decodeQueue(rows[0]?.queue ?? null), message];
    yield* sql`UPDATE threads SET queue = ${JSON.stringify(queue)} WHERE id = ${threadId}`;
    return queue;
  });

/** Removes and returns the head of the queue, or null when it is empty. */
export const dequeueNextMessage = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly queue: string | null }>`
      SELECT queue FROM threads WHERE id = ${threadId}
    `;
    const queue = decodeQueue(rows[0]?.queue ?? null);
    const head = queue[0];
    if (head === undefined) return null;
    yield* sql`UPDATE threads SET queue = ${JSON.stringify(queue.slice(1))} WHERE id = ${threadId}`;
    return head;
  });
