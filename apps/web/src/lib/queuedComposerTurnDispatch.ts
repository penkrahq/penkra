// FILE: queuedComposerTurnDispatch.ts
// Purpose: Dispatches a persisted composer follow-up without requiring its ChatView to be mounted.
// Layer: Web orchestration helper

import {
  CommandId,
  MessageId,
  type AssistantDeliveryMode,
  type NativeApi,
  type ThreadId,
} from "@penkra/contracts";

import type { QueuedComposerChatTurn } from "../composerDraftDomain";
import { appendAssistantSelectionsToPrompt } from "./assistantSelections";
import {
  filterPromptProviderMentionReferences,
  filterPromptSkillReferences,
} from "./composerMentions";
import { appendPastedTextsToPrompt } from "./composerPastedText";
import { formatOutgoingComposerPrompt, stageUploadComposerAttachments } from "./composerSend";
import { appendFileCommentsToPrompt } from "./fileComments";
import { appendTerminalContextsToPrompt, IMAGE_ONLY_BOOTSTRAP_PROMPT } from "./terminalContext";

export function queuedComposerTurnMessageId(queuedTurnId: string): MessageId {
  return MessageId.makeUnsafe(`composer-queue:${queuedTurnId}`);
}

export function queuedComposerTurnServerMessageId(
  queuedTurn: Pick<QueuedComposerChatTurn, "id" | "serverMessageId">,
): MessageId {
  return queuedTurn.serverMessageId ?? queuedComposerTurnMessageId(queuedTurn.id);
}

const queuedComposerTurnDispatches = new Map<string, Promise<void>>();

function queuedComposerTurnDispatchKey(threadId: ThreadId, queuedTurnId: string): string {
  return `${threadId}:${queuedTurnId}`;
}

export function getQueuedComposerTurnDispatchInFlight(
  threadId: ThreadId,
  queuedTurnId: string,
): Promise<void> | undefined {
  return queuedComposerTurnDispatches.get(queuedComposerTurnDispatchKey(threadId, queuedTurnId));
}

async function performQueuedComposerTurnDispatch(input: {
  api: NativeApi;
  threadId: ThreadId;
  queuedTurn: QueuedComposerChatTurn;
  assistantDeliveryMode: AssistantDeliveryMode;
}): Promise<void> {
  const { api, threadId, queuedTurn, assistantDeliveryMode } = input;
  const messageText = appendPastedTextsToPrompt(
    appendFileCommentsToPrompt(
      appendTerminalContextsToPrompt(
        appendAssistantSelectionsToPrompt(queuedTurn.prompt, queuedTurn.assistantSelections),
        queuedTurn.terminalContexts,
      ),
      queuedTurn.fileComments,
    ),
    queuedTurn.pastedTexts,
  );
  const outgoingTextSeed =
    messageText || (queuedTurn.images.length > 0 ? IMAGE_ONLY_BOOTSTRAP_PROMPT : "");
  const outgoingText = formatOutgoingComposerPrompt({
    provider: queuedTurn.selectedProvider,
    model: queuedTurn.selectedModel,
    effort: queuedTurn.selectedPromptEffort,
    text: outgoingTextSeed,
  });
  const skills = filterPromptSkillReferences(
    outgoingText,
    queuedTurn.skills,
    queuedTurn.selectedProvider,
  );
  const mentions = filterPromptProviderMentionReferences(outgoingText, queuedTurn.mentions);
  const stagedAttachments = await stageUploadComposerAttachments({
    threadId,
    images: queuedTurn.images,
    files: queuedTurn.files,
    assistantSelections: queuedTurn.assistantSelections,
  });

  await stagedAttachments.runWithDispatch((attachments) =>
    api.orchestration.dispatchCommand({
      type: "thread.turn.start",
      // Stable ids make a transport-ambiguous retry idempotent server-side.
      commandId: CommandId.makeUnsafe(`composer-queue:${queuedTurn.id}`),
      threadId,
      message: {
        messageId: queuedComposerTurnServerMessageId(queuedTurn),
        role: "user",
        text: outgoingText,
        attachments,
        ...(skills.length > 0 ? { skills } : {}),
        ...(mentions.length > 0 ? { mentions } : {}),
      },
      modelSelection: queuedTurn.modelSelection,
      connectionId: queuedTurn.connectionId,
      ...(queuedTurn.providerOptionsForDispatch
        ? { providerOptions: queuedTurn.providerOptionsForDispatch }
        : {}),
      assistantDeliveryMode,
      dispatchMode: "queue",
      runtimeMode: queuedTurn.runtimeMode,
      createdAt: queuedTurn.createdAt,
    }),
  );
}

export function dispatchQueuedComposerTurn(input: {
  api: NativeApi;
  threadId: ThreadId;
  queuedTurn: QueuedComposerChatTurn;
  assistantDeliveryMode: AssistantDeliveryMode;
}): Promise<void> {
  const key = queuedComposerTurnDispatchKey(input.threadId, input.queuedTurn.id);
  const existing = queuedComposerTurnDispatches.get(key);
  if (existing) {
    return existing;
  }
  const dispatch = performQueuedComposerTurnDispatch(input);
  queuedComposerTurnDispatches.set(key, dispatch);
  const clearDispatch = () => {
    if (queuedComposerTurnDispatches.get(key) === dispatch) {
      queuedComposerTurnDispatches.delete(key);
    }
  };
  void dispatch.then(clearDispatch, clearDispatch);
  return dispatch;
}
