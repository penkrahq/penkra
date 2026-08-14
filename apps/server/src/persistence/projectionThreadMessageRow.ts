import {
  ChatAttachment,
  MessageDispatchOrigin,
  MessageDeliveryState,
  NonNegativeInt,
  ProviderMentionReference,
  ProviderSkillReference,
  TurnDispatchMode,
  type OrchestrationMessage,
} from "@penkra/contracts";
import { Schema, Struct } from "effect";

import {
  ProjectionThreadMessage,
  type ProjectionThreadMessage as ProjectionThreadMessageRecord,
} from "./Services/ProjectionThreadMessages.ts";

export const ProjectionThreadMessageDbRowSchema = ProjectionThreadMessage.mapFields(
  Struct.assign({
    isStreaming: Schema.Number,
    attachments: Schema.NullOr(Schema.fromJsonString(Schema.Array(ChatAttachment))),
    skills: Schema.NullOr(Schema.fromJsonString(Schema.Array(ProviderSkillReference))),
    mentions: Schema.NullOr(Schema.fromJsonString(Schema.Array(ProviderMentionReference))),
    dispatchMode: Schema.NullOr(TurnDispatchMode),
    dispatchOrigin: Schema.NullOr(MessageDispatchOrigin),
    deliveryState: Schema.optional(Schema.NullOr(MessageDeliveryState)).pipe(
      Schema.withDecodingDefault(() => null),
    ),
    deliveryQueued: Schema.optional(Schema.NullOr(Schema.Number)).pipe(
      Schema.withDecodingDefault(() => null),
    ),
    deliverySequence: Schema.optional(Schema.NullOr(NonNegativeInt)).pipe(
      Schema.withDecodingDefault(() => null),
    ),
    sequence: Schema.NullOr(NonNegativeInt),
  }),
);

export type ProjectionThreadMessageDbRow = Schema.Schema.Type<
  typeof ProjectionThreadMessageDbRowSchema
>;

export function projectionThreadMessageFromRow(
  row: ProjectionThreadMessageDbRow,
): ProjectionThreadMessageRecord {
  return {
    messageId: row.messageId,
    threadId: row.threadId,
    turnId: row.turnId,
    role: row.role,
    text: row.text,
    isStreaming: row.isStreaming === 1,
    source: row.source,
    ...(row.sequence !== null ? { sequence: row.sequence } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.attachments !== null ? { attachments: row.attachments } : {}),
    ...(row.skills !== null ? { skills: row.skills } : {}),
    ...(row.mentions !== null ? { mentions: row.mentions } : {}),
    ...(row.dispatchMode ? { dispatchMode: row.dispatchMode } : {}),
    ...(row.dispatchOrigin ? { dispatchOrigin: row.dispatchOrigin } : {}),
    ...(row.deliveryState !== null
      ? {
          deliveryState: row.deliveryState,
          deliveryQueued: row.deliveryQueued === 1,
          ...(row.deliverySequence !== null ? { deliverySequence: row.deliverySequence } : {}),
        }
      : {}),
  };
}

export function orchestrationMessageFromProjectionRow(
  row: ProjectionThreadMessageDbRow,
): OrchestrationMessage {
  return {
    id: row.messageId,
    role: row.role,
    text: row.text,
    ...(row.attachments !== null ? { attachments: row.attachments } : {}),
    ...(row.skills !== null ? { skills: row.skills } : {}),
    ...(row.mentions !== null ? { mentions: row.mentions } : {}),
    ...(row.dispatchMode ? { dispatchMode: row.dispatchMode } : {}),
    ...(row.dispatchOrigin ? { dispatchOrigin: row.dispatchOrigin } : {}),
    ...(row.deliveryState !== null &&
    row.deliveryState !== undefined &&
    row.deliverySequence !== null &&
    row.deliverySequence !== undefined
      ? {
          delivery: {
            state: row.deliveryState,
            queued: row.deliveryQueued === 1,
            sequence: row.deliverySequence,
          },
        }
      : {}),
    turnId: row.turnId,
    streaming: row.isStreaming === 1,
    source: row.source,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
