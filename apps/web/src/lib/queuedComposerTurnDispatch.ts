// FILE: queuedComposerTurnDispatch.ts
// Purpose: Maps legacy composer turn identifiers to their server message ids.
// Layer: Web orchestration presentation helper

import { MessageId } from "@penkra/contracts";

import type { QueuedComposerChatTurn } from "../composerDraftDomain";

export function queuedComposerTurnMessageId(queuedTurnId: string): MessageId {
  return MessageId.makeUnsafe(`composer-queue:${queuedTurnId}`);
}

export function queuedComposerTurnServerMessageId(
  queuedTurn: Pick<QueuedComposerChatTurn, "id" | "serverMessageId">,
): MessageId {
  return queuedTurn.serverMessageId ?? queuedComposerTurnMessageId(queuedTurn.id);
}
