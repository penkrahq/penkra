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
  ApprovalRequestId,
  type MessageDispatchOrigin,
  MessageId,
  type OrchestrationThreadActivity,
  type ProviderMentionReference,
  type ProviderSkillReference,
  type TurnDispatchMode,
  type UserInputQuestion,
} from "@penkra/contracts";
import { EventId, ThreadId, TurnId } from "@penkra/contracts";
import type { CleanCoreThreadItem } from "@penkra/contracts";

import type { PendingUserInput } from "../../pendingInteractionDerivation";
import type { ChatMessage } from "../../types";
import type { ChatAttachment } from "../../types";
import { deriveWorkLogEntries, type TimelineEntry, type WorkLogEntry } from "../../workLog";

type ActivityTone = OrchestrationThreadActivity["tone"];

export function parseThreadItemData(data: string | null): Record<string, unknown> | null {
  if (data === null) return null;
  try {
    const parsed = JSON.parse(data) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function normalizeTone(value: unknown, itemKind: string): ActivityTone {
  if (value === "tool") return "tool";
  if (value === "error") return "error";
  if (value === "approval") return "info";
  if (itemKind === "tool") return "tool";
  return "info";
}

function normalizeKind(value: unknown, itemKind: string, status: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  if (itemKind === "notice") return "runtime.warning";
  return status === "running" ? "tool.updated" : "tool.completed";
}

function normalizeSummary(value: unknown, text: string | null): string {
  return typeof value === "string" && value.length > 0 ? value : (text ?? "");
}

/**
 * Rebuild the canonical activity for a tool/notice item. A truncated or
 * non-JSON `data` copy (an old OpenCode task result) still renders through
 * TimelineWorkEntryRow with the item text as its detail.
 */
export function threadItemToActivity(item: CleanCoreThreadItem): OrchestrationThreadActivity {
  const data = parseThreadItemData(item.data);
  const hasActivityShape =
    data !== null && ("payload" in data || "kind" in data || "tone" in data);
  const payload = hasActivityShape ? (data?.payload ?? null) : (data ?? { detail: item.text ?? null });
  return {
    id: EventId.makeUnsafe(item.sourceId),
    tone: normalizeTone(data?.tone, item.kind),
    kind: normalizeKind(data?.kind, item.kind, item.status),
    summary: normalizeSummary(data?.summary, item.text),
    payload: payload as OrchestrationThreadActivity["payload"],
    turnId: item.turnId === null ? null : TurnId.makeUnsafe(item.turnId),
    sequence: item.seq,
    createdAt: item.createdAt,
  };
}

export function threadItemToWorkLogEntry(item: CleanCoreThreadItem): WorkLogEntry | null {
  return deriveWorkLogEntries([threadItemToActivity(item)], undefined)[0] ?? null;
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
    requestId: ApprovalRequestId.makeUnsafe(requestId),
    createdAt: item.createdAt,
    questions,
  };
}

export interface ThreadItemUserContent {
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly skills: ReadonlyArray<ProviderSkillReference>;
  readonly mentions: ReadonlyArray<ProviderMentionReference>;
  readonly dispatchMode?: TurnDispatchMode;
  readonly dispatchOrigin?: MessageDispatchOrigin;
  readonly senderThreadId?: ThreadId;
}

export function threadItemToUserContent(item: CleanCoreThreadItem): ThreadItemUserContent {
  const data = parseThreadItemData(item.data);
  const attachments = Array.isArray(data?.attachments)
    ? (data.attachments as ReadonlyArray<ChatAttachment>)
    : [];
  const skills = Array.isArray(data?.skills)
    ? (data.skills as ReadonlyArray<ProviderSkillReference>)
    : [];
  const mentions = Array.isArray(data?.mentions)
    ? (data.mentions as ReadonlyArray<ProviderMentionReference>)
    : [];
  const dispatchMode =
    data?.dispatchMode === "queue" || data?.dispatchMode === "steer"
      ? data.dispatchMode
      : undefined;
  const dispatchOrigin =
    data?.dispatchOrigin === "user" ||
    data?.dispatchOrigin === "automation" ||
    data?.dispatchOrigin === "agent"
      ? data.dispatchOrigin
      : undefined;
  const senderThreadId =
    typeof data?.senderThreadId === "string" && data.senderThreadId.length > 0
      ? ThreadId.makeUnsafe(data.senderThreadId)
      : undefined;
  return {
    text: item.text ?? "",
    attachments,
    skills,
    mentions,
    ...(dispatchMode ? { dispatchMode } : {}),
    ...(dispatchOrigin ? { dispatchOrigin } : {}),
    ...(senderThreadId ? { senderThreadId } : {}),
  };
}

/** A `user`/`text` item as the `ChatMessage` the transcript rows render. */
export function threadItemToChatMessage(item: CleanCoreThreadItem): ChatMessage {
  const content = threadItemToUserContent(item);
  const isUser = item.kind === "user";
  return {
    id: MessageId.makeUnsafe(item.sourceId),
    role: isUser ? "user" : "assistant",
    text: content.text,
    attachments: [...content.attachments],
    skills: [...content.skills],
    mentions: [...content.mentions],
    ...(content.dispatchMode ? { dispatchMode: content.dispatchMode } : {}),
    ...(content.dispatchOrigin ? { dispatchOrigin: content.dispatchOrigin } : {}),
    ...(content.senderThreadId ? { senderThreadId: content.senderThreadId } : {}),
    sequence: item.seq,
    turnId: item.turnId === null ? null : TurnId.makeUnsafe(item.turnId),
    createdAt: item.createdAt,
    ...(item.status === "done" ? { completedAt: item.updatedAt } : {}),
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
export function threadItemsToTimelineEntries(
  items: ReadonlyArray<CleanCoreThreadItem>,
): TimelineEntry[] {
  const ordered = [...items].toSorted((left, right) => left.seq - right.seq);
  const entries: TimelineEntry[] = [];
  for (const item of ordered) {
    if (item.kind === "user" || item.kind === "text") {
      entries.push({
        id: item.sourceId,
        kind: "message",
        createdAt: item.createdAt,
        message: threadItemToChatMessage(item),
      });
      continue;
    }
    const entry = threadItemToWorkLogEntry(item);
    if (entry) {
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
