import { Schema } from "effect";
import { ThreadId } from "./baseSchemas";

/** Shared by canonical user items and transcript messages without a schema import cycle. */
export const MessageOrigin = Schema.Union([
  Schema.TaggedStruct("user", {}),
  // Historical delivered messages can retain authorship after sender data was lost.
  Schema.TaggedStruct("agent", { senderThreadId: Schema.optionalKey(ThreadId) }),
]);
export const SendingMessageOrigin = Schema.Union([
  Schema.TaggedStruct("user", {}),
  Schema.TaggedStruct("agent", { senderThreadId: ThreadId }),
]);
export type MessageOrigin = typeof MessageOrigin.Type;
