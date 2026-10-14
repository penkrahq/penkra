// FILE: providerTurnInput.ts
// Purpose: Prepare sender attribution, thread context and skill text for provider turns.
// Layer: Provider prompt preparation

import type {
  CleanCoreQueuedMessage,
  ProviderKind,
  ProviderMentionReference,
  ProviderSkillReference,
  ThreadId,
} from "@penkra/contracts";
import { Effect, Schema } from "effect";
import { SendingMessageOrigin } from "@penkra/contracts";
import type { ThreadReadsShape } from "../cleanCore/ThreadReads.ts";
import { buildInlineSkillInstructions } from "./skillPromptInjection.ts";
import {
  resolveThreadMentionPromptProjection,
  threadMentionContextSuffix,
} from "./threadMentionContext.ts";

function toNonEmptyProviderInput(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

// Codex app-server still expects `$skill` text next to the structured skill item.
export function normalizeSkillMentionTextForProvider(input: {
  readonly provider: ProviderKind;
  readonly messageText: string;
  readonly skills?: ReadonlyArray<ProviderSkillReference>;
}): string {
  if (input.provider !== "codex" || !input.skills || input.skills.length === 0) {
    return input.messageText;
  }

  let nextText = input.messageText;
  for (const skill of input.skills) {
    const escapedName = skill.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    nextText = nextText.replace(
      new RegExp(`(^|\\s)/${escapedName}(?=\\s|$)`, "gi"),
      `$1$${skill.name}`,
    );
  }
  return nextText;
}

/** Stable attribution is part of each member's text, never the whole delivery's origin. */
export function formatUserTurnMember(
  message: Pick<CleanCoreQueuedMessage, "text" | "origin">,
): string {
  const origin = Schema.decodeUnknownSync(SendingMessageOrigin)(message.origin);
  if (origin._tag === "user") return message.text;
  return [
    "<agent_message_sender>",
    "This message was written by the agent in another Penkra thread, not by the user.",
    `Thread ID: ${origin.senderThreadId}`,
    "</agent_message_sender>",
    "",
    message.text,
  ].join("\n");
}

export function formatUserTurnMembers(
  messages: ReadonlyArray<Pick<CleanCoreQueuedMessage, "text" | "origin">>,
): string {
  return messages.map(formatUserTurnMember).join("\n\n").trim();
}

export const resolveProviderTurnContext = Effect.fnUntraced(function* (
  input: {
    readonly messages: ReadonlyArray<Pick<CleanCoreQueuedMessage, "text" | "origin">>;
    readonly mentions: ReadonlyArray<ProviderMentionReference> | undefined;
    readonly maxContextChars: number;
  },
  snapshotQuery: Pick<ThreadReadsShape, "getThreadDetailById">,
) {
  const projection = yield* resolveThreadMentionPromptProjection({
    mentions: input.mentions,
    snapshotQuery,
    maxTotalContextChars: input.maxContextChars,
  });
  return {
    messageText: `${formatUserTurnMembers(input.messages)}${threadMentionContextSuffix(projection.contextBlocks)}`,
    providerMentions: projection.providerMentions,
  };
});

export const buildProviderTurnInput = Effect.fnUntraced(function* (input: {
  readonly threadId: ThreadId;
  readonly provider: ProviderKind;
  readonly messageText: string;
  readonly skills: ReadonlyArray<ProviderSkillReference> | undefined;
  readonly maxSkillChars: number;
}) {
  const inlineText =
    input.skills !== undefined && input.skills.length > 0
      ? yield* Effect.tryPromise(() =>
          buildInlineSkillInstructions({
            provider: input.provider,
            skills: input.skills!,
            maxChars: Math.max(0, input.maxSkillChars - "\n\n".length),
          }),
        ).pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to inline portable skill instructions", {
              threadId: input.threadId,
              error,
            }).pipe(Effect.as("")),
          ),
        )
      : "";
  return toNonEmptyProviderInput(
    normalizeSkillMentionTextForProvider({
      provider: input.provider,
      messageText: inlineText ? `${input.messageText}\n\n${inlineText}` : input.messageText,
      ...(input.skills === undefined ? {} : { skills: input.skills }),
    }),
  );
});
