// FILE: providerTurnInput.ts
// Purpose: Prepare sender attribution, thread context and skill text for provider turns.
// Layer: Provider prompt preparation

import type {
  MessageDispatchOrigin,
  ProviderKind,
  ProviderMentionReference,
  ProviderSkillReference,
  ThreadId,
} from "@penkra/contracts";
import { Effect, Option } from "effect";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { buildInlineSkillInstructions } from "./skillPromptInjection.ts";
import {
  clampMentionTitle,
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

export const resolveProviderTurnContext = Effect.fnUntraced(function* (
  input: {
    readonly messageText: string;
    readonly dispatchOrigin: MessageDispatchOrigin | undefined;
    readonly senderThreadId: ThreadId | undefined;
    readonly mentions: ReadonlyArray<ProviderMentionReference> | undefined;
    readonly maxContextChars: number;
  },
  snapshotQuery: Pick<ProjectionSnapshotQueryShape, "getThreadDetailById" | "getThreadShellById">,
) {
  const projection = yield* resolveThreadMentionPromptProjection({
    mentions: input.mentions,
    snapshotQuery,
    maxTotalContextChars: input.maxContextChars,
  });
  const senderShell =
    input.dispatchOrigin === "agent" && input.senderThreadId
      ? Option.getOrNull(yield* snapshotQuery.getThreadShellById(input.senderThreadId))
      : null;
  const senderTitle = senderShell?.title;
  const senderContext =
    input.dispatchOrigin === "agent" && input.senderThreadId
      ? [
          "<agent_message_sender>",
          "This message was written by the agent in another Penkra thread, not by the user.",
          ...(senderTitle?.trim()
            ? [`Thread: ${JSON.stringify(clampMentionTitle(senderTitle))}`]
            : []),
          `Thread ID: ${input.senderThreadId}`,
          "</agent_message_sender>",
          "",
          "",
        ].join("\n")
      : "";
  return {
    messageText: `${senderContext}${input.messageText}${threadMentionContextSuffix(projection.contextBlocks)}`,
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
            maxChars: input.maxSkillChars,
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
