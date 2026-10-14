// Frozen 203/204 wire shapes. Never import current contracts or admission code here.
import { Schema } from "effect";
const Id = Schema.Trim.check(Schema.isNonEmpty());
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const AttachmentId = Id.check(Schema.isMaxLength(128), Schema.isPattern(/^[a-z0-9_-]+$/i));
const Name = Id.check(Schema.isMaxLength(255));
const Mime = Id.check(Schema.isMaxLength(100));
export const Attachment203 = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("image"),
    id: AttachmentId,
    name: Name,
    mimeType: Mime.check(Schema.isPattern(/^image\//i)),
    sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(10 * 1024 * 1024)),
  }),
  Schema.Struct({
    type: Schema.Literal("file"),
    id: AttachmentId,
    name: Name,
    mimeType: Mime,
    sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(25 * 1024 * 1024)),
  }),
  Schema.Struct({
    type: Schema.Literal("assistant-selection"),
    id: AttachmentId,
    assistantMessageId: Id,
    text: Id.check(Schema.isMaxLength(4_000)),
  }),
]);
const Reference = Schema.Struct({ name: Id, path: Id });
const References = Schema.optionalKey(Schema.Array(Reference));
const Origin = Schema.Union([
  Schema.TaggedStruct("user", {}),
  Schema.TaggedStruct("agent", { senderThreadId: Schema.optionalKey(Id) }),
]);
const SendingOrigin = Schema.Union([
  Schema.TaggedStruct("user", {}),
  Schema.TaggedStruct("agent", { senderThreadId: Id }),
]);
export const UserItemData203 = Schema.Struct({
  origin: Origin,
  attachments: Schema.Array(Attachment203),
  skills: References,
  mentions: References,
  steered: Schema.optionalKey(Schema.Literal(true)),
});
export const QueuedMessage203 = Schema.Struct({
  messageId: Id,
  text: Schema.String,
  attachments: Schema.Array(Attachment203),
  origin: SendingOrigin,
  skills: References,
  mentions: References,
  queuedAt: Schema.String,
});
export const SendPayload204 = Schema.Struct({
  message: QueuedMessage203,
  skills: References,
  mentions: References,
  deliveryMessageId: Schema.String,
  deliveryRequestId: Schema.String,
  batchMessageIds: Schema.optionalKey(Schema.Array(Schema.String)),
});

/** Frozen admission rules and sender formatting from 204, not today's implementation. */
export function validatePending204(input: {
  message: typeof QueuedMessage203.Type;
  skills?: readonly (typeof Reference.Type)[] | undefined;
  mentions?: readonly (typeof Reference.Type)[] | undefined;
}) {
  const { message } = input;
  const text =
    message.origin._tag === "user"
      ? message.text
      : [
          "<agent_message_sender>",
          "This message was written by the agent in another Penkra thread, not by the user.",
          `Thread ID: ${message.origin.senderThreadId}`,
          "</agent_message_sender>",
          "",
          message.text,
        ].join("\n");
  if (message.attachments.length > 8 || text.trim().length > 120_000)
    throw new Error(
      "A retained pending message exceeds the 204 per-turn attachment or formatted text limit.",
    );
  if (!message.text.trim() && !message.attachments.length)
    throw new Error("A retained pending message has no text or attachment.");
  const data = Schema.encodeSync(UserItemData203)({
    origin: message.origin,
    attachments: message.attachments,
    ...(input.skills === undefined ? {} : { skills: input.skills }),
    ...(input.mentions === undefined ? {} : { mentions: input.mentions }),
    steered: true,
  });
  if (Buffer.byteLength(JSON.stringify(data), "utf8") > 64 * 1024)
    throw new Error("A retained pending message exceeds the 204 metadata limit.");
}
