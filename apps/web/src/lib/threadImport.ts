// FILE: threadImport.ts
// Purpose: Builds projected transcript rows for an exact provider-native fork.

import { MessageId, type ThreadImportedMessage } from "@penkra/contracts";

import type { Thread } from "../types";
import { stripEmbeddedAssistantSelections } from "./assistantSelections";
import { randomUUID } from "./utils";

function isImportableThreadMessage(
  message: Thread["messages"][number],
): message is Thread["messages"][number] & { role: "user" | "assistant" } {
  return (message.role === "user" || message.role === "assistant") && message.streaming === false;
}

export function buildThreadImportedMessages(
  thread: Pick<Thread, "messages">,
): ReadonlyArray<ThreadImportedMessage> {
  return thread.messages.filter(isImportableThreadMessage).map((message) => {
    const importedText =
      message.role === "user" ? stripEmbeddedAssistantSelections(message.text) : message.text;
    const importedMessage: ThreadImportedMessage = {
      messageId: MessageId.makeUnsafe(randomUUID()),
      role: message.role,
      text: importedText,
      createdAt: message.createdAt,
      updatedAt: message.completedAt ?? message.createdAt,
    };
    const attachments =
      message.attachments && message.attachments.length > 0
        ? message.attachments.map((attachment) =>
            attachment.type === "assistant-selection"
              ? {
                  type: attachment.type,
                  id: attachment.id,
                  assistantMessageId: attachment.assistantMessageId,
                  text: attachment.text,
                }
              : {
                  type: attachment.type,
                  id: attachment.id,
                  name: attachment.name,
                  mimeType: attachment.mimeType,
                  sizeBytes: attachment.sizeBytes,
                },
          )
        : null;
    return attachments ? Object.assign(importedMessage, { attachments }) : importedMessage;
  });
}
