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
import { resolveThreadBindingRevisionAtAdmission } from "./threadBindingAdmission";

export function queuedComposerTurnMessageId(queuedTurnId: string): MessageId {
  return MessageId.makeUnsafe(`composer-queue:${queuedTurnId}`);
}

export function queuedComposerTurnCommandId(
  queuedTurn: Pick<QueuedComposerChatTurn, "id" | "dispatchAttempt">,
): CommandId {
  const attempt = queuedTurn.dispatchAttempt ?? 0;
  return CommandId.makeUnsafe(
    attempt === 0
      ? `composer-queue:${queuedTurn.id}`
      : `composer-queue:${queuedTurn.id}:${attempt}`,
  );
}

export function isQueuedComposerBindingRevisionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return (
    error.code === "THREAD_BINDING_REVISION_REQUIRED" ||
    error.code === "THREAD_BINDING_REVISION_STALE"
  );
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
  persistDispatchAdmission: (attempt: number, bindingRevision: number) => void;
}): Promise<void> {
  const { api, threadId, queuedTurn, assistantDeliveryMode, persistDispatchAdmission } = input;
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
  // A queued follow-up can wait while the thread's provider binding changes.
  // Resolve its concurrency token at admission instead of persisting a token
  // that may already be stale by the time this background dispatcher runs.
  const dispatchAttempt = queuedTurn.dispatchAttempt ?? 0;
  const bindingRevision =
    queuedTurn.dispatchBindingRevision ??
    (await resolveThreadBindingRevisionAtAdmission({
      hasThreadStarted: true,
      loadCurrentRevision: async () =>
        (await api.provider.getThreadBinding({ threadId })).binding?.revision,
    }));
  if (queuedTurn.dispatchBindingRevision === undefined) {
    // Persist before crossing the network. If the process exits after server
    // acceptance but before local acknowledgement, restart replays the exact
    // same command identity and cannot duplicate a provider/model switch.
    persistDispatchAdmission(dispatchAttempt, bindingRevision);
  }

  await stagedAttachments.runWithDispatch((attachments) =>
    api.orchestration.dispatchCommand({
      type: "thread.turn.start",
      // Stable ids make a transport-ambiguous retry idempotent server-side.
      commandId: queuedComposerTurnCommandId(queuedTurn),
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
      bindingRevision,
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
  persistDispatchAdmission: (attempt: number, bindingRevision: number) => void;
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
