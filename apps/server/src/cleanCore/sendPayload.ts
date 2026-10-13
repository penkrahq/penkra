// FILE: sendPayload.ts
// Purpose: Keeps uncapped send inputs private and freezes one explicitly admitted delivery cohort.
// Layer: Server clean-core send persistence
import { CleanCoreSendMessageInput, MessageId } from "@penkra/contracts";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  CurrentManagedAttachmentPrincipal,
  type ManagedAttachmentPrincipal,
} from "../managedAttachmentPrincipal.ts";
import { QueuedMessage } from "./threadQueue.ts";
import { upsertThreadItem } from "./threadStore.ts";
import type { SendMessageInput } from "./sendMessage.ts";
import { encodeUserItemAdmission } from "./userItemAdmission.ts";

const SendPayload = Schema.Struct({
  message: QueuedMessage,
  skills: CleanCoreSendMessageInput.fields.skills,
  mentions: CleanCoreSendMessageInput.fields.mentions,
  deliveryMessageId: Schema.String,
  batchMessageIds: Schema.optional(Schema.Array(Schema.String)),
});
export type StoredSendPayload = typeof SendPayload.Type;
export const decodeSendPayload = (value: string): StoredSendPayload =>
  Schema.decodeUnknownSync(SendPayload)(JSON.parse(value));

export const admitSendingPayload = (
  input: SendMessageInput,
  plan: "deliver" | "steer" | "interrupt-deliver",
  principal?: ManagedAttachmentPrincipal,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const data = yield* encodeUserItemAdmission(input, plan !== "deliver");
    const owner = principal ?? (yield* CurrentManagedAttachmentPrincipal);
    const failed: Array<{ seq: number; sourceId: string; payload: StoredSendPayload }> = [];
    {
      let after = 0;
      while (true) {
        const rows = yield* sql<{ seq: number; sourceId: string; sendPayload: string }>`
        SELECT seq,source_id AS "sourceId",send_payload AS "sendPayload" FROM thread_items
        WHERE thread_id=${input.threadId} AND kind='user' AND status='failed' AND send_payload IS NOT NULL AND seq>${after}
        ORDER BY seq LIMIT 50`;
        for (const row of rows)
          failed.push({ ...row, payload: decodeSendPayload(row.sendPayload) });
        if (rows.length < 50) break;
        after = rows[rows.length - 1]!.seq;
      }
    }
    const batchMessageIds = [...failed.map((row) => row.sourceId), input.message.messageId];
    for (const row of failed) {
      const attachments = row.payload.message.attachments.filter(
        (attachment) => attachment.type !== "assistant-selection",
      );
      if (attachments.length) {
        const ids = attachments.map((attachment) => attachment.id);
        const claimed = yield* sql<{ attachmentId: string }>`
        UPDATE managed_attachment_blobs SET claim_message_id=${input.message.messageId},owner_kind=${owner.ownerKind},owner_id=${owner.ownerId}
        WHERE owner_thread_id=${input.threadId} AND state='claimed' AND claim_message_id=${row.sourceId}
        AND attachment_id IN ${sql.in(ids)} RETURNING attachment_id AS "attachmentId"`;
        if (claimed.length !== ids.length)
          return yield* Effect.fail(
            new Error("A failed message attachment is no longer owned by this thread."),
          );
      }
      const { batchMessageIds: _oldBatch, ...original } = row.payload;
      yield* sql`UPDATE thread_items SET status='sending',send_payload=${JSON.stringify({ ...original, deliveryMessageId: input.message.messageId })}
      WHERE thread_id=${input.threadId} AND source_id=${row.sourceId}`;
    }
    yield* upsertThreadItem({
      threadId: input.threadId,
      sourceId: input.message.messageId,
      kind: "user",
      status: "sending",
      text: input.message.text,
      admissionPlan: plan,
      sendPayload: JSON.stringify({
        message: input.message,
        skills: input.skills,
        mentions: input.mentions,
        deliveryMessageId: input.message.messageId,
        batchMessageIds,
      }),
      data,
      createdAt: input.message.queuedAt,
      updatedAt: input.message.queuedAt,
    });
  });

/** The leader records membership once; every member keeps its own original full input. */
export const readSendCohort = (threadId: string, messageId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [member] = yield* sql<{ sendPayload: string }>`
    SELECT send_payload AS "sendPayload" FROM thread_items WHERE thread_id=${threadId} AND source_id=${messageId} AND kind='user' AND status='sending'`;
    if (!member) return null;
    const own = decodeSendPayload(member.sendPayload);
    const [leader] = yield* sql<{ sendPayload: string }>`
    SELECT send_payload AS "sendPayload" FROM thread_items WHERE thread_id=${threadId} AND source_id=${own.deliveryMessageId} AND kind='user'`;
    const payload = decodeSendPayload(leader!.sendPayload);
    const ids = payload.batchMessageIds!;
    const rows: Array<{ sourceId: string; payload: StoredSendPayload }> = [];
    // Bound each indexed lookup while retaining the complete operational cohort.
    for (let start = 0; start < ids.length; start += 50) {
      const page = yield* sql<{ sourceId: string; sendPayload: string }>`
      SELECT source_id AS "sourceId",send_payload AS "sendPayload" FROM thread_items
      WHERE thread_id=${threadId} AND source_id IN ${sql.in(ids.slice(start, start + 50))} ORDER BY seq`;
      for (const row of page)
        rows.push({ sourceId: row.sourceId, payload: decodeSendPayload(row.sendPayload) });
    }
    return { leaderId: own.deliveryMessageId, ids, rows };
  });

export const readSendDispatch = (input: SendMessageInput) =>
  Effect.gen(function* () {
    const cohort = yield* readSendCohort(input.threadId, input.message.messageId);
    if (cohort === null) return null;
    const skills = cohort.rows.flatMap((row) => row.payload.skills ?? []);
    const mentions = cohort.rows.flatMap((row) => row.payload.mentions ?? []);
    return {
      ...input,
      message: {
        ...input.message,
        messageId: MessageId.makeUnsafe(cohort.leaderId),
        text: cohort.rows.map((row) => row.payload.message.text).join("\n\n"),
        attachments: cohort.rows.flatMap((row) => row.payload.message.attachments),
      },
      ...(skills.length ? { skills } : {}),
      ...(mentions.length ? { mentions } : {}),
    } satisfies SendMessageInput;
  });
