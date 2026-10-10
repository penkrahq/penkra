// Provider-confirmed sends and the persisted FIFO (TODO 2.3/2.4).
import {
  ThreadId,
  TurnId,
  type CleanCoreSendResult,
  type CleanCoreSendMessageInput,
} from "@penkra/contracts";
import { Deferred, Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PROVIDER_CUTOFF_NOTICE } from "./providerStreamConsumer.ts";
import { enqueueMessage, planSend, readThreadQueue, type QueuedMessage } from "./threadQueue.ts";
import { upsertThreadItem, type ThreadPublisher } from "./threadStore.ts";

export const PLAY_TURN_RECOVERY_PROMPT =
  "The previous turn did not finish. Continue the existing task from the current state. Verify the current state before repeating any action whose outcome may be uncertain.";

export interface SendMessageInput extends Pick<
  CleanCoreSendMessageInput,
  "providerOptions" | "assistantDeliveryMode" | "skills" | "mentions"
> {
  readonly threadId: string;
  readonly message: QueuedMessage;
  readonly dispatchMode: "queue" | "steer";
  readonly supportsSteer: boolean;
}
export interface SendDriver {
  readonly claimAttachments: (input: SendMessageInput) => Effect.Effect<void, Error>;
  /** Dispatch and return the adapter's acknowledged native turn id. */
  readonly dispatch: (
    input: SendMessageInput,
    mode: "deliver" | "steer",
  ) => Effect.Effect<string, Error>;
  readonly interrupt: (threadId: string) => Effect.Effect<void, Error>;
}

/** Subscribe before dispatch, and correlate the acknowledgement with the exact start event. */
export const deliverMessage = (
  publisher: ThreadPublisher,
  driver: SendDriver,
  input: SendMessageInput,
  plan: "deliver" | "steer" | "interrupt-deliver",
  runningTurnId: string | null,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* driver.claimAttachments(input);
      const result = yield* Deferred.make<
        { readonly turnId: string; readonly at: string },
        Error
      >();
      const started = new Map<string, string>();
      const exited = yield* Deferred.make<never, Error>();
      let delivering = plan !== "interrupt-deliver";
      let acknowledged: string | null = null;
      const unsubscribe = publisher.subscribeProvider((event) => {
        if (event.type === "turn.started" && event.threadId === input.threadId) {
          started.set(event.turnId, event.at);
          if (acknowledged === event.turnId)
            Effect.runSync(Deferred.succeed(result, { turnId: event.turnId, at: event.at }));
        } else if (
          delivering &&
          event.type === "provider.exited" &&
          event.threadIds.includes(input.threadId)
        ) {
          Effect.runSync(
            Deferred.fail(
              result,
              new Error(event.reason === undefined ? PROVIDER_CUTOFF_NOTICE : event.reason),
            ),
          );
          Effect.runSync(
            Deferred.fail(
              exited,
              new Error(event.reason === undefined ? PROVIDER_CUTOFF_NOTICE : event.reason),
            ),
          );
        }
      });
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      if (plan === "interrupt-deliver") {
        const ended = yield* Deferred.make<void>();
        const stopListening = publisher.subscribeProvider((event) => {
          if (
            (event.type === "turn.ended" &&
              event.threadId === input.threadId &&
              event.turnId === runningTurnId) ||
            (event.type === "provider.exited" && event.threadIds.includes(input.threadId))
          ) {
            Effect.runSync(Deferred.succeed(ended, undefined));
          }
        });
        yield* Effect.addFinalizer(() => Effect.sync(stopListening));
        yield* driver.interrupt(input.threadId);
        yield* Deferred.await(ended);
      }
      delivering = true;
      acknowledged = yield* Effect.raceFirst(
        driver.dispatch(input, plan === "steer" ? "steer" : "deliver"),
        Deferred.await(exited),
      );
      const now = new Date().toISOString();
      const confirmed =
        plan === "steer"
          ? { turnId: acknowledged, at: now }
          : started.has(acknowledged)
            ? { turnId: acknowledged, at: started.get(acknowledged)! }
            : yield* Deferred.await(result);
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* upsertThreadItem({
            threadId: input.threadId,
            sourceId: input.message.messageId,
            turnId: confirmed.turnId,
            kind: "user",
            status: "sent",
            text: input.message.text,
            data: JSON.stringify({
              delivery:
                plan === "deliver" ? "started" : plan === "steer" ? "steered" : "interrupted",
              attachments: input.message.attachments,
              senderThreadId: input.message.senderThreadId,
              dispatchOrigin: input.message.dispatchOrigin,
            }),
            createdAt: confirmed.at,
            updatedAt: confirmed.at,
          });
          yield* sql`UPDATE threads SET draft = NULL, draft_updated_at = ${confirmed.at}, updated_at = ${confirmed.at} WHERE id = ${input.threadId}`;
        }),
      );
      publisher.publish({ threadId: input.threadId });
      return {
        threadId: ThreadId.makeUnsafe(input.threadId),
        messageId: input.message.messageId,
        delivery: plan === "deliver" ? "started" : plan === "steer" ? "steered" : "interrupted",
        turnId: TurnId.makeUnsafe(confirmed.turnId),
      } satisfies CleanCoreSendResult;
    }),
  ).pipe(
    Effect.catch((error) => {
      if ("_tag" in error && error._tag === "SqlError") return Effect.fail(error);
      return Effect.succeed({
        threadId: ThreadId.makeUnsafe(input.threadId),
        messageId: input.message.messageId,
        delivery: "failed" as const,
        error: error.message,
      } satisfies CleanCoreSendResult);
    }),
  );

export const sendMessage = (
  publisher: ThreadPublisher,
  driver: SendDriver,
  input: SendMessageInput,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly state: "idle" | "running" | "error";
      readonly activeTurnId: string | null;
    }>`SELECT state, active_turn_id AS "activeTurnId" FROM threads WHERE id = ${input.threadId}`;
    const thread = rows[0];
    if (thread === undefined)
      return {
        threadId: ThreadId.makeUnsafe(input.threadId),
        messageId: input.message.messageId,
        delivery: "failed" as const,
        error: "The thread does not exist.",
      } satisfies CleanCoreSendResult;
    const queue = yield* readThreadQueue(input.threadId);
    const plan = planSend({
      state: thread.state,
      dispatchMode: input.dispatchMode,
      supportsSteer: input.supportsSteer,
      queueLength: queue.length,
    });
    if (plan !== "queue")
      return yield* deliverMessage(publisher, driver, input, plan, thread.activeTurnId);
    const queued = yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* driver.claimAttachments(input);
        return yield* enqueueMessage(input.threadId, input.message);
      }),
    );
    publisher.publish({ threadId: input.threadId });
    return {
      threadId: ThreadId.makeUnsafe(input.threadId),
      messageId: input.message.messageId,
      delivery: "queued" as const,
      position: queued.length,
      queueLength: queued.length,
      runningTurnId: thread.activeTurnId === null ? null : TurnId.makeUnsafe(thread.activeTurnId),
    } satisfies CleanCoreSendResult;
  }).pipe(
    Effect.catch((error) => {
      if ("_tag" in error && error._tag === "SqlError") return Effect.fail(error);
      return Effect.succeed({
        threadId: ThreadId.makeUnsafe(input.threadId),
        messageId: input.message.messageId,
        delivery: "failed" as const,
        error: error.message,
      } satisfies CleanCoreSendResult);
    }),
  );

export const playThread = (
  publisher: ThreadPublisher,
  driver: SendDriver,
  input: { readonly threadId: string; readonly message: QueuedMessage },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly state: string;
    }>`SELECT state FROM threads WHERE id = ${input.threadId}`;
    if (rows[0]?.state !== "idle") return null;
    const cutoff =
      yield* sql`SELECT 1 FROM thread_items WHERE thread_id = ${input.threadId} AND kind = 'notice' AND text = ${PROVIDER_CUTOFF_NOTICE} LIMIT 1`;
    if (cutoff.length === 0) return null;
    return yield* sendMessage(publisher, driver, {
      threadId: input.threadId,
      message: { ...input.message, text: PLAY_TURN_RECOVERY_PROMPT },
      dispatchMode: "queue",
      supportsSteer: false,
    });
  });
