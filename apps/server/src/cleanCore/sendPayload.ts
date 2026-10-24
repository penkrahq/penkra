// Purpose: Select and persist one oldest-first, per-turn-bounded delivery.
import {
  CleanCoreSendMessageInput,
  MessageId,
  ProviderKind,
  ThreadId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
} from "@penkra/contracts";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import {
  CurrentManagedAttachmentPrincipal,
  type ManagedAttachmentPrincipal,
} from "../managedAttachmentPrincipal.ts";
import {
  buildProviderTurnInput,
  formatUserTurnMember,
  formatUserTurnMembers,
  resolveProviderTurnContext,
} from "../provider/providerTurnInput.ts";
import { makeThreadReads } from "./ThreadReads.ts";
import { QueuedMessage, readThreadQueue } from "./threadQueue.ts";
import { upsertThreadItem } from "./threadStore.ts";
import type { SendMessageInput, DeliveryPlan } from "./sendMessage.ts";
import { encodeUserItemAdmission } from "./userItemAdmission.ts";

export const SendPayload = Schema.Struct({
  message: QueuedMessage,
  skills: CleanCoreSendMessageInput.fields.skills,
  mentions: CleanCoreSendMessageInput.fields.mentions,
  deliveryMessageId: Schema.String,
  deliveryRequestId: Schema.String,
  batchMessageIds: Schema.optional(Schema.Array(Schema.String)),
});
export type StoredSendPayload = typeof SendPayload.Type;
export const decodeSendPayload = (value: string): StoredSendPayload =>
  Schema.decodeUnknownSync(SendPayload)(JSON.parse(value));

/** This is the only cohort selection, shared by direct, head, Play and steer delivery. */
export const admitSendingPayload = (
  input: SendMessageInput,
  plan: DeliveryPlan,
  principal?: ManagedAttachmentPrincipal,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const owner = principal ?? (yield* CurrentManagedAttachmentPrincipal);
    const data = yield* encodeUserItemAdmission(input, plan !== "deliver");
    const selected: Array<{ sourceId: string; payload: StoredSendPayload }> = [];
    let attachments = 0;
    // Keep the exact trimmed body length plus its not-yet-visible trailing
    // whitespace. This avoids rebuilding every growing prefix (quadratic work).
    let bounds = { chars: 0, trailing: 0 };
    const measure = (message: QueuedMessage) => {
      const part = formatUserTurnMember(message);
      const separator = selected.length ? "\n\n".length : 0;
      const trimmed = part.trim();
      if (!trimmed)
        return {
          chars: bounds.chars,
          trailing: bounds.chars ? bounds.trailing + separator + part.length : 0,
        };
      const body = part.trimEnd();
      return {
        chars: bounds.chars
          ? bounds.chars + bounds.trailing + separator + body.length
          : trimmed.length,
        trailing: part.length - body.length,
      };
    };
    const fits = (message: QueuedMessage, next: typeof bounds) =>
      attachments + message.attachments.length <= PROVIDER_SEND_TURN_MAX_ATTACHMENTS &&
      next.chars <= PROVIDER_SEND_TURN_MAX_INPUT_CHARS;
    let after = 0;
    let complete = false;
    while (!complete) {
      const rows = yield* sql<{ seq: number; sourceId: string; sendPayload: string }>`
      SELECT seq,source_id AS "sourceId",send_payload AS "sendPayload" FROM thread_items
      WHERE thread_id=${input.threadId} AND kind='user' AND status='failed' AND send_payload IS NOT NULL AND seq>${after}
      ORDER BY seq LIMIT 50`;
      for (const row of rows) {
        if (row.sourceId === input.message.messageId) continue;
        const payload = decodeSendPayload(row.sendPayload);
        const next = measure(payload.message);
        if (!fits(payload.message, next)) {
          complete = true;
          break;
        }
        selected.push({ sourceId: row.sourceId, payload });
        bounds = next;
        attachments += payload.message.attachments.length;
      }
      if (complete || rows.length < 50) break;
      after = rows[rows.length - 1]!.seq;
    }
    const includesRequested = !complete && fits(input.message, measure(input.message));
    const current: StoredSendPayload = {
      message: input.message,
      skills: input.skills,
      mentions: input.mentions,
      deliveryMessageId: input.message.messageId,
      deliveryRequestId: input.message.messageId,
    };
    if (includesRequested) selected.push({ sourceId: input.message.messageId, payload: current });
    if (!selected.length)
      return yield* Effect.die(
        new Error("A pending message exceeds the limits checked at its admission."),
      );
    const leader = selected[selected.length - 1]!;
    const deliveryMessageId = leader.sourceId;
    const deliveryPlan =
      !includesRequested && plan === "steer" ? ("interrupt-deliver" as const) : plan;
    const ids = selected.map((row) => row.sourceId);
    for (const row of selected) {
      const isRequested = row.sourceId === input.message.messageId;
      const blobIds = row.payload.message.attachments
        .filter((attachment) => attachment.type !== "assistant-selection")
        .map((attachment) => attachment.id);
      if (!isRequested && blobIds.length) {
        const claimed = yield* sql<{ attachmentId: string }>`
        UPDATE managed_attachment_blobs SET claim_message_id=${deliveryMessageId},owner_kind=${owner.ownerKind},owner_id=${owner.ownerId}
        WHERE owner_thread_id=${input.threadId} AND state='claimed' AND claim_message_id=${row.sourceId}
        AND attachment_id IN ${sql.in(blobIds)} RETURNING attachment_id AS "attachmentId"`;
        if (claimed.length !== blobIds.length)
          return yield* Effect.fail(
            new Error("A failed message attachment is no longer owned by this thread."),
          );
      }
      const { batchMessageIds: _oldBatch, ...original } = row.payload;
      const payload = JSON.stringify({
        ...original,
        deliveryMessageId,
        deliveryRequestId: input.message.messageId,
        ...(row.sourceId === deliveryMessageId ? { batchMessageIds: ids } : {}),
      });
      if (isRequested) {
        yield* upsertThreadItem({
          threadId: input.threadId,
          sourceId: row.sourceId,
          kind: "user",
          status: "sending",
          text: input.message.text,
          admissionPlan: deliveryPlan,
          sendPayload: payload,
          data,
          createdAt: input.message.queuedAt,
          updatedAt: input.message.queuedAt,
        });
      } else {
        yield* sql`UPDATE thread_items SET status='sending',turn_id=NULL,data=json_remove(data,'$.anchor'),admission_plan=${deliveryPlan},send_payload=${payload}
        WHERE thread_id=${input.threadId} AND source_id=${row.sourceId}`;
      }
    }
    let queueLength = 0;
    if (!includesRequested) {
      const queue = yield* readThreadQueue(input.threadId);
      const deferred = {
        ...input.message,
        ...(input.skills === undefined ? {} : { skills: input.skills }),
        ...(input.mentions === undefined ? {} : { mentions: input.mentions }),
      };
      const remaining = [
        deferred,
        ...queue.filter((message) => message.messageId !== deferred.messageId),
      ];
      yield* sql`UPDATE threads SET queue=${JSON.stringify(remaining)} WHERE id=${input.threadId}`;
      queueLength = remaining.length;
    }
    const [record] = yield* sql<{
      seq: number;
    }>`SELECT seq FROM thread_items WHERE thread_id=${input.threadId} AND source_id=${deliveryMessageId}`;
    return {
      includesRequested,
      seq: record!.seq,
      queueLength,
      delivery: {
        input: {
          ...input,
          message: leader.payload.message,
          skills: leader.payload.skills,
          mentions: leader.payload.mentions,
        },
        plan: deliveryPlan,
      },
    };
  });

/** The leader records membership once; every member keeps its own full input. */
export const readSendCohort = (threadId: string, messageId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [member] = yield* sql<{ sendPayload: string }>`
    SELECT send_payload AS "sendPayload" FROM thread_items WHERE thread_id=${threadId} AND source_id=${messageId} AND kind='user' AND status='sending'`;
    if (!member) return null;
    const own = decodeSendPayload(member.sendPayload);
    const [leader] = yield* sql<{ sendPayload: string }>`
    SELECT send_payload AS "sendPayload" FROM thread_items WHERE thread_id=${threadId} AND source_id=${own.deliveryMessageId} AND kind='user' AND status='sending'`;
    const payload = decodeSendPayload(leader!.sendPayload);
    const ids = payload.batchMessageIds!;
    const rows: Array<{ sourceId: string; payload: StoredSendPayload }> = [];
    for (let start = 0; start < ids.length; start += 50) {
      const page = yield* sql<{ sourceId: string; sendPayload: string }>`
      SELECT source_id AS "sourceId",send_payload AS "sendPayload" FROM thread_items
      WHERE thread_id=${threadId} AND source_id IN ${sql.in(ids.slice(start, start + 50))} ORDER BY seq`;
      const byId = new Map(page.map((row) => [row.sourceId, row]));
      for (const id of ids.slice(start, start + 50)) {
        const row = byId.get(id)!;
        rows.push({ sourceId: row.sourceId, payload: decodeSendPayload(row.sendPayload) });
      }
    }
    return { leaderId: own.deliveryMessageId, requestId: payload.deliveryRequestId, ids, rows };
  });

/** Optional context and skills use only the space left by the complete selected messages. */
export const readSendDispatch = (input: SendMessageInput) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const cohort = yield* readSendCohort(input.threadId, input.message.messageId);
    if (cohort === null) return null;
    const members = cohort.rows.map((row) => row.payload.message);
    const skills = cohort.rows.flatMap((row) => row.payload.skills ?? []);
    const mentions = cohort.rows.flatMap((row) => row.payload.mentions ?? []);
    const [thread] = yield* sql<{
      provider: string;
    }>`SELECT provider FROM threads WHERE id=${input.threadId}`;
    const provider = Schema.decodeUnknownSync(ProviderKind)(thread!.provider);
    const context = yield* resolveProviderTurnContext(
      {
        messages: members,
        mentions,
        maxContextChars: Math.max(
          0,
          PROVIDER_SEND_TURN_MAX_INPUT_CHARS -
            formatUserTurnMembers(members).length -
            "\n\n".length,
        ),
      },
      yield* makeThreadReads,
    );
    const text = yield* buildProviderTurnInput({
      threadId: ThreadId.make(input.threadId),
      provider,
      messageText: context.messageText,
      skills,
      maxSkillChars: Math.max(0, PROVIDER_SEND_TURN_MAX_INPUT_CHARS - context.messageText.length),
    });
    yield* Effect.logInfo("provider.delivery.prepared", {
      threadId: input.threadId,
      deliveryMessageId: cohort.leaderId,
      requestedMessageId: cohort.requestId,
      memberCount: cohort.ids.length,
      firstMessageId: cohort.ids[0],
      requestedMessageDeferred: !cohort.ids.includes(cohort.requestId),
      inputChars: (text ?? "").length,
      attachmentCount: members.reduce((count, message) => count + message.attachments.length, 0),
    });
    return {
      ...input,
      message: {
        ...input.message,
        messageId: MessageId.make(cohort.leaderId),
        text: text ?? "",
        attachments: members.flatMap((message) => message.attachments),
      },
      skills,
      mentions: context.providerMentions,
    } satisfies SendMessageInput;
  });
