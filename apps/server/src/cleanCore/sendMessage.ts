import { ThreadPolicyError } from "./threadErrors.ts";
// Persist send admission before provider work; settle outcomes in canonical rows.
import {
  ThreadId,
  type CleanCoreSendAdmission,
  type CleanCoreSendMessageInput,
} from "@penkra/contracts";
import { Cause, Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { admitSendingPayload, readSendCohort, readSendDispatch } from "./sendPayload.ts";
import { nextCommittedDraftTimestamp } from "./threadDraftTimestamp.ts";
import { draftAfterSend } from "./threadDraft.ts";
import { enqueueMessage, planSend, readThreadQueue, type QueuedMessage } from "./threadQueue.ts";
import { type ThreadPublisher } from "./threadStore.ts";
import { encodeUserItemAdmission } from "./userItemAdmission.ts";

export const PLAY_TURN_RECOVERY_PROMPT =
  "The previous turn did not finish. Continue the existing task from the current state. Verify the current state before repeating any action whose outcome may be uncertain.";

export interface SendMessageInput extends Pick<
  CleanCoreSendMessageInput,
  | "reviewTarget"
  | "runtimeMode"
  | "draftUpdatedAt"
  | "providerOptions"
  | "assistantDeliveryMode"
  | "skills"
  | "mentions"
  | "modelSelection"
  | "connectionId"
> {
  readonly threadId: string;
  readonly message: QueuedMessage;
  readonly dispatchMode: "queue" | "steer";
  readonly supportsSteer: boolean;
}
export interface SendDriver {
  readonly claimAttachments: (input: SendMessageInput) => Effect.Effect<void, Error>;
  readonly dispatch: (input: SendMessageInput, mode: DeliveryPlan) => Effect.Effect<void, Error>;
}
type DeliveryPlan = "deliver" | "steer" | "interrupt-deliver";

/** One committed admission, including clearing the composer. No provider wait. */
export const sendMessage = (
  publisher: ThreadPublisher,
  driver: SendDriver,
  input: SendMessageInput,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* encodeUserItemAdmission(input, input.dispatchMode === "steer");
    const admission = yield* sql.withTransaction(
      Effect.gen(function* () {
        const [thread] = yield* sql<{
          state: "idle" | "running" | "error";
          provider: string;
          draft: string | null;
          draftUpdatedAt: string | null;
          archivedAt: string | null;
          deletedAt: string | null;
        }>`
        SELECT state,provider,draft,draft_updated_at AS "draftUpdatedAt",archived_at AS "archivedAt",deleted_at AS "deletedAt"
        FROM threads WHERE id=${input.threadId}`;
        if (thread === undefined || thread.deletedAt !== null)
          return yield* Effect.fail(new Error("The thread does not exist."));
        if (thread.archivedAt !== null)
          return yield* Effect.fail(
            new ThreadPolicyError({
              operation: "sendMessage",
              code: "thread_archived",
              detail: "This thread is archived. Unarchive it to send messages.",
            }),
          );
        if (input.modelSelection !== undefined && input.modelSelection.provider !== thread.provider)
          return yield* Effect.fail(
            new Error(
              "This thread uses a different provider. To use another provider, start a new thread.",
            ),
          );
        const [existing] = yield* sql<{ seq: number; plan: DeliveryPlan }>`
        SELECT seq,admission_plan AS plan FROM thread_items WHERE thread_id=${input.threadId}
          AND source_id=${input.message.messageId} AND kind='user'`;
        if (existing !== undefined)
          return {
            threadId: ThreadId.makeUnsafe(input.threadId),
            messageId: input.message.messageId,
            plan: existing.plan,
            seq: existing.seq,
          } satisfies CleanCoreSendAdmission;
        const queue = yield* readThreadQueue(input.threadId);
        const position = queue.findIndex(
          (message) => message.messageId === input.message.messageId,
        );
        if (position !== -1 && input.dispatchMode === "queue")
          return {
            threadId: ThreadId.makeUnsafe(input.threadId),
            messageId: input.message.messageId,
            plan: "queue" as const,
            position: position + 1,
            queueLength: queue.length,
          } satisfies CleanCoreSendAdmission;
        // An admitted start is busy even before its provider turn-start event.
        const pending = yield* sql`SELECT 1 FROM thread_items WHERE thread_id=${input.threadId}
        AND kind='user' AND status='sending' LIMIT 1`;
        const plan = planSend({
          state: thread.state,
          dispatchMode: input.dispatchMode,
          supportsSteer: input.supportsSteer,
          // Explicit promotion bypasses waiting work, never an admitted start.
          queueLength:
            (position !== -1 && input.dispatchMode === "steer" ? 0 : queue.length) + pending.length,
        });
        const request =
          position === -1
            ? input
            : {
                ...input,
                message: queue[position]!,
                draftUpdatedAt: undefined,
              };
        yield* driver.claimAttachments(request);
        if (plan === "queue") {
          if (position !== -1)
            return {
              threadId: ThreadId.makeUnsafe(input.threadId),
              messageId: input.message.messageId,
              plan,
              position: position + 1,
              queueLength: queue.length,
            } satisfies CleanCoreSendAdmission;
          const queued = yield* enqueueMessage(
            input.threadId,
            input.message,
            input,
            input.draftUpdatedAt,
          );
          return {
            threadId: ThreadId.makeUnsafe(input.threadId),
            messageId: input.message.messageId,
            plan,
            position: queued.length,
            queueLength: queued.length,
          } satisfies CleanCoreSendAdmission;
        }
        yield* writeSendingMessage(request, plan);
        if (
          request.draftUpdatedAt !== undefined &&
          thread.draftUpdatedAt === request.draftUpdatedAt
        ) {
          const draft = draftAfterSend(thread.draft, thread.provider, request);
          const draftUpdatedAt = nextCommittedDraftTimestamp(
            thread.draftUpdatedAt,
            new Date().toISOString(),
          );
          yield* sql`UPDATE threads SET draft=${draft},draft_updated_at=${draftUpdatedAt} WHERE id=${input.threadId}`;
        }
        const [row] = yield* sql<{ seq: number }>`SELECT seq FROM thread_items
        WHERE thread_id=${input.threadId} AND source_id=${input.message.messageId}`;
        return {
          threadId: ThreadId.makeUnsafe(input.threadId),
          messageId: input.message.messageId,
          plan,
          seq: row!.seq,
        } satisfies CleanCoreSendAdmission;
      }),
    );
    publisher.publish({ threadId: input.threadId });
    return admission;
  });

/** Also used when a queued head begins delivery; its selection is read then. */
export const writeSendingMessage = admitSendingPayload;

/** Scoped background dispatch; the coordinator owns steering and interruption. */
export const deliverMessage = (
  publisher: ThreadPublisher,
  driver: SendDriver,
  input: SendMessageInput,
  plan: DeliveryPlan,
) =>
  Effect.gen(function* () {
    const dispatch = yield* readSendDispatch(input);
    if (dispatch !== null) yield* driver.dispatch(dispatch, plan);
  }).pipe(
    Effect.catchCause((cause) => {
      // Server shutdown leaves the admission for the existing startup cut-off.
      if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
      const failure = Cause.squash(cause);
      const error = failure instanceof Error ? failure.message : String(failure);
      return settleMessage(
        publisher,
        { type: "failed", threadId: input.threadId, messageId: input.message.messageId, error },
        new Date().toISOString(),
      ).pipe(
        Effect.andThen(
          Effect.logError("admitted provider delivery failed", {
            threadId: input.threadId,
            messageId: input.message.messageId,
            error,
          }),
        ),
      );
    }),
  );

export type MessageOutcome = { readonly threadId: string; readonly messageId: string } & (
  | { readonly type: "acknowledged"; readonly turnId: string }
  | { readonly type: "failed"; readonly error: string }
);

/** The one outcome writer; callers report native results, never repair rows. */
export const settleMessage = (publisher: ThreadPublisher, outcome: MessageOutcome, at: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const changed = yield* sql.withTransaction(
      Effect.gen(function* () {
        const cohort = yield* readSendCohort(outcome.threadId, outcome.messageId);
        if (cohort === null) return false;
        const [thread] = yield* sql<{
          queue: string;
        }>`SELECT queue FROM threads WHERE id=${outcome.threadId}`;
        const queue = JSON.parse(thread!.queue) as QueuedMessage[];
        const queued = queue.some((message) => message.messageId === cohort.leaderId);
        if (outcome.type === "acknowledged") {
          yield* sql`UPDATE thread_items SET status='sent',send_payload=NULL,turn_id=${outcome.turnId},updated_at=${at}
            WHERE thread_id=${outcome.threadId} AND source_id IN (SELECT value FROM json_each(${JSON.stringify(cohort.ids)}))`;
          yield* sql`UPDATE threads SET last_error=NULL WHERE id=${outcome.threadId}`;
          if (queued)
            yield* sql`UPDATE threads SET queue=${JSON.stringify(queue.filter((message) => message.messageId !== cohort.leaderId))},updated_at=${at} WHERE id=${outcome.threadId}`;
        } else {
          for (const row of cohort.rows) {
            const ids = row.payload.message.attachments
              .filter((attachment) => attachment.type !== "assistant-selection")
              .map((attachment) => attachment.id);
            if (ids.length)
              yield* sql`UPDATE managed_attachment_blobs SET claim_message_id=${row.sourceId}
              WHERE owner_thread_id=${outcome.threadId} AND state='claimed' AND claim_message_id=${cohort.leaderId} AND attachment_id IN ${sql.in(ids)}`;
          }
          yield* sql`UPDATE thread_items SET status='failed',updated_at=${at}
            WHERE thread_id=${outcome.threadId} AND source_id IN (SELECT value FROM json_each(${JSON.stringify(cohort.ids)}))`;
          if (queued) {
            yield* sql`DELETE FROM thread_items WHERE thread_id=${outcome.threadId} AND source_id=${cohort.leaderId}`;
            yield* sql`UPDATE threads SET state='error',active_turn_id=NULL,last_error=${outcome.error},updated_at=${at} WHERE id=${outcome.threadId}`;
          } else
            yield* sql`UPDATE threads SET last_error=${outcome.error},updated_at=${at} WHERE id=${outcome.threadId}`;
        }
        return true;
      }),
    );
    if (changed) publisher.publish({ threadId: outcome.threadId });
  });

/** A restart cannot resume an unacknowledged admission; retain it as a failure. */
export const failSendingMessagesOnStartup = (
  publisher: ThreadPublisher,
  at: string,
  error: string,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    let after: string | null = null;
    while (true) {
      const threads: readonly { id: string }[] =
        after === null
          ? yield* sql<{ id: string }>`SELECT id FROM threads ORDER BY id LIMIT 50`
          : yield* sql<{
              id: string;
            }>`SELECT id FROM threads WHERE id>${after} ORDER BY id LIMIT 50`;
      if (threads.length === 0) return;
      for (const thread of threads) {
        while (true) {
          const pending = yield* sql<{ messageId: string }>`SELECT source_id AS "messageId"
            FROM thread_items WHERE thread_id=${thread.id} AND kind='user' AND status='sending' ORDER BY seq LIMIT 50`;
          if (pending.length === 0) break;
          for (const row of pending)
            yield* settleMessage(
              publisher,
              { type: "failed", threadId: thread.id, messageId: row.messageId, error },
              at,
            );
        }
      }
      after = threads[threads.length - 1]!.id;
    }
  });
