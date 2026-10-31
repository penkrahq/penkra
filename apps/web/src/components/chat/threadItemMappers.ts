// FILE: threadItemMappers.ts
// Purpose: Pure mappers from a clean-core `thread_items` row to the props of the
// existing chat components (0.14.4 step 8.5c). Tool/notice items rebuild the
// canonical `OrchestrationThreadActivity` so deriveWorkLogEntries and
// TimelineWorkEntryRow render them unchanged; question items rebuild the
// PendingUserInput the composer panel consumes; user items expose their
// attachments, skills and mentions.
// Layer: Web chat presentation helpers (pure)
// Exports: parseThreadItemData, threadItemToActivity, threadItemToWorkLogEntry,
//   threadItemToPendingUserInput, threadItemToUserContent, ThreadItemUserContent

import {
  type MessageOrigin,
  MessageId,
  type ProviderMentionReference,
  type ProviderSkillReference,
  type UserInputQuestion,
} from "@penkra/contracts";
import { TurnId } from "@penkra/contracts";
import { decodeUserItemData } from "@penkra/shared/userItemData";
import type { CleanCoreThreadItem } from "@penkra/contracts";

import type { PendingUserInput } from "../../pendingUserInput";
import {
  parseThreadItemData,
  threadItemToActivity,
  TOOL_STATUS_BY_ITEM_STATUS,
} from "@penkra/shared/threadItemActivity";
export { parseThreadItemData, threadItemToActivity } from "@penkra/shared/threadItemActivity";
import { toAttachmentPreviewUrl } from "../../lib/wsHttpUrl";
import type { ChatMessage } from "../../types";
import type { ChatAttachment } from "../../types";
import { deriveWorkLogEntries, type TimelineEntry, type WorkLogEntry } from "../../workLog";

export function threadItemToWorkLogEntry(item: CleanCoreThreadItem): WorkLogEntry | null {
  // Turn records supply timing, not an extra work-log row.
  if (item.kind === "turn") return null;
  if (item.kind === "question") {
    if (item.status === "open") return null;
    const data = parseThreadItemData(item.data);
    const answers =
      data?.answers && typeof data.answers === "object"
        ? Object.values(data.answers)
            .flatMap((value) => (Array.isArray(value) ? value : [value]))
            .map(String)
            .join(", ")
        : "";
    return {
      id: item.sourceId,
      createdAt: item.createdAt,
      sequence: item.seq,
      turnId: item.turnId,
      tone: "info",
      activityKind: `question.${item.status}`,
      label: `${item.text ?? "Question"} — ${item.status === "cancelled" ? "No answer (turn ended)" : answers}`,
    };
  }
  const entry = deriveWorkLogEntries([threadItemToActivity(item)], undefined)[0] ?? null;
  if (entry === null || item.kind !== "tool") return entry;
  const toolStatus = TOOL_STATUS_BY_ITEM_STATUS[item.status];
  return toolStatus ? { ...entry, toolStatus } : entry;
}

function stripQuestionPrefix(sourceId: string): string {
  const prefix = "question:";
  return sourceId.startsWith(prefix) ? sourceId.slice(prefix.length) : sourceId;
}

export function threadItemToPendingUserInput(item: CleanCoreThreadItem): PendingUserInput {
  const data = parseThreadItemData(item.data);
  const questions = Array.isArray(data?.questions)
    ? (data.questions as ReadonlyArray<UserInputQuestion>)
    : [];
  const requestId = stripQuestionPrefix(item.sourceId);
  return {
    requestId: requestId,
    createdAt: item.createdAt,
    questions,
    ...(typeof data?.lifecycleGeneration === "string"
      ? { lifecycleGeneration: data.lifecycleGeneration }
      : {}),
  };
}

export const threadItemsToPendingUserInputs = (
  items: ReadonlyArray<CleanCoreThreadItem>,
): PendingUserInput[] =>
  items
    .filter((item) => item.kind === "question" && item.status === "open")
    .toSorted((a, b) => a.seq - b.seq)
    .map(threadItemToPendingUserInput);

export interface ThreadItemUserContent {
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly skills: ReadonlyArray<ProviderSkillReference>;
  readonly mentions: ReadonlyArray<ProviderMentionReference>;
  readonly origin?: MessageOrigin;
  readonly steered?: true;
  readonly anchor?: import("@penkra/contracts").ThreadItemAnchor;
}

export function threadItemToUserContent(item: CleanCoreThreadItem): ThreadItemUserContent {
  if (item.kind !== "user")
    return { text: item.text ?? "", attachments: [], skills: [], mentions: [] };
  const data = decodeUserItemData(item.data === null ? null : JSON.parse(item.data));
  return {
    text: item.text ?? "",
    ...data,
    attachments: data.attachments.map((attachment) =>
      attachment.type === "image"
        ? {
            ...attachment,
            previewUrl: toAttachmentPreviewUrl(`/attachments/${encodeURIComponent(attachment.id)}`),
          }
        : attachment,
    ),
    skills: data.skills ?? [],
    mentions: data.mentions ?? [],
  };
}

/** A `user`/`text` item as the `ChatMessage` the transcript rows render. */
export function threadItemToChatMessage(item: CleanCoreThreadItem): ChatMessage {
  const content = threadItemToUserContent(item);
  const isUser = item.kind === "user";
  return {
    id: MessageId.make(item.sourceId),
    role: isUser ? "user" : "assistant",
    text: content.text,
    attachments: [...content.attachments],
    skills: [...content.skills],
    mentions: [...content.mentions],
    ...(content.origin === undefined ? {} : { origin: content.origin }),
    ...(content.steered ? { steered: content.steered } : {}),
    sequence: item.seq,
    turnId: item.turnId === null ? null : TurnId.make(item.turnId),
    createdAt: item.createdAt,
    ...(item.status === "done" ? { completedAt: item.updatedAt } : {}),
    ...(isUser && (item.status === "sending" || item.status === "sent" || item.status === "failed")
      ? { sendStatus: item.status }
      : {}),
    streaming: item.status === "streaming",
  };
}

/**
 * Pure mapper from clean-core items to the `TimelineEntry` rows the transcript
 * already renders (0.14.4 step 8.5c-iii). `user`/`text` become message rows;
 * every other kind becomes a work row through the same derivation the old
 * activities used. Items are already oldest-first, but the result is sorted by
 * `seq` so ordering never depends on the caller.
 */
export function isVisibleThreadMessageItem(item: CleanCoreThreadItem): boolean {
  return (
    item.kind === "text" ||
    (item.kind === "user" &&
      decodeUserItemData(item.data === null ? {} : JSON.parse(item.data)).origin._tag !==
        "recovery")
  );
}

export function threadItemsToTimelineEntries(
  items: ReadonlyArray<CleanCoreThreadItem>,
): TimelineEntry[] {
  const ordered = [...items].toSorted((left, right) => left.seq - right.seq);
  const entries: TimelineEntry[] = [];
  const messagePositions = new Map(ordered.map((item) => [item.sourceId, item.seq]));
  for (const item of ordered) {
    if (item.kind === "user" && !isVisibleThreadMessageItem(item)) continue;
    if (item.kind === "user" || item.kind === "text") {
      const message = threadItemToChatMessage(item);
      const anchor = item.kind === "user" ? threadItemToUserContent(item).anchor : undefined;
      if (anchor !== undefined) {
        const sourceId = "messageId" in anchor ? anchor.messageId : anchor.turnRowSourceId;
        message.anchor = { ...anchor, sequence: messagePositions.get(sourceId) };
      }
      entries.push({
        id: item.sourceId,
        kind: "message",
        createdAt: item.createdAt,
        message,
      });
      continue;
    }
    let entry = threadItemToWorkLogEntry(item);
    if (entry) {
      const anchor = parseThreadItemData(item.data)?.anchor;
      if (
        anchor !== null &&
        typeof anchor === "object" &&
        "messageId" in anchor &&
        typeof anchor.messageId === "string"
      )
        entry = {
          ...entry,
          anchor: { messageId: anchor.messageId, sequence: messagePositions.get(anchor.messageId) },
        };
      entries.push({
        id: entry.id,
        kind: "work",
        createdAt: entry.createdAt,
        entry,
      });
    }
  }
  return entries;
}
