// Purpose: Check the canonical metadata before a direct or queued send writes anything.
import {
  UserItemData,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type CleanCoreSendMessageInput,
} from "@penkra/contracts";
import { Effect, Schema } from "effect";
import { ThreadPolicyError } from "./threadErrors.ts";
import { THREAD_ITEM_DATA_LIMIT_BYTES } from "./threadItemData.ts";
import { formatUserTurnMembers } from "../provider/providerTurnInput.ts";

export const encodeUserItemAdmission = (
  input: Pick<CleanCoreSendMessageInput, "message" | "skills" | "mentions">,
  steered: boolean,
) =>
  Effect.try({
    try: () => {
      if (
        input.message.attachments.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS ||
        formatUserTurnMembers([input.message]).length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS
      )
        throw new ThreadPolicyError({
          operation: "sendMessage",
          code: "message_too_large",
          detail:
            "This message exceeds the supported per-turn text or attachment limit. Your message has not been accepted.",
        });
      if (!input.message.text.trim() && !input.message.attachments.length)
        throw new ThreadPolicyError({
          operation: "sendMessage",
          code: "empty_message",
          detail: "A message needs text or an attachment. Your message has not been accepted.",
        });
      const data = JSON.stringify(
        Schema.encodeSync(UserItemData)({
          origin: input.message.origin,
          attachments: input.message.attachments,
          ...(input.skills === undefined ? {} : { skills: input.skills }),
          ...(input.mentions === undefined ? {} : { mentions: input.mentions }),
          ...(steered ? { steered: true as const } : {}),
        }),
      );
      if (Buffer.byteLength(data, "utf8") > THREAD_ITEM_DATA_LIMIT_BYTES)
        throw new ThreadPolicyError({
          operation: "sendMessage",
          code: "message_metadata_too_large",
          detail:
            "This message's attachment and reference metadata exceeds the supported size. Your message has not been accepted.",
        });
      return data;
    },
    catch: (cause) =>
      cause instanceof ThreadPolicyError
        ? cause
        : new ThreadPolicyError({
            operation: "sendMessage",
            code: "invalid_message_metadata",
            detail: "This message's metadata is invalid. Your message has not been accepted.",
            cause,
          }),
  });
