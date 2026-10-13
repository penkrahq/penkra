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
  type OrchestrationThreadActivity,
  type ProviderMentionReference,
  type ProviderSkillReference,
  type UserInputQuestion,
} from "@penkra/contracts";
import { EventId, TurnId } from "@penkra/contracts";
import { decodeUserItemData } from "@penkra/shared/userItemData";
import type { CleanCoreThreadItem } from "@penkra/contracts";

import type { PendingUserInput } from "../../pendingInteractionDerivation";
import type { PenkraMcpToolStatus } from "../../lib/toolCallLabel";
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
  // A tool item's lifecycle is its item status, so a settled item derives
  // tool.completed even if its original data still says tool.started.
  if (itemKind === "tool") return status === "running" ? "tool.updated" : "tool.completed";
  if (typeof value === "string" && value.length > 0) return value;
  if (itemKind === "notice") return "runtime.warning";
  return "tool.completed";
}

function normalizeSummary(value: unknown, text: string | null): string {
  return typeof value === "string" && value.length > 0 ? value : (text ?? "");
}

/**
 * Rebuild the canonical activity for a tool/notice item. A truncated or
 * non-JSON `data` copy (an old OpenCode task result) still renders through
 * TimelineWorkEntryRow with the item text as its detail.
 */
const TOOL_STATUS_BY_ITEM_STATUS: Record<string, PenkraMcpToolStatus> = {
  running: "running",
  done: "completed",
  error: "failed",
  interrupted: "cancelled",
};

export function threadItemToActivity(item: CleanCoreThreadItem): OrchestrationThreadActivity {
  const data = parseThreadItemData(item.data);
  const hasActivityShape = data !== null && ("payload" in data || "kind" in data || "tone" in data);
  const rawPayload = hasActivityShape
    ? (data?.payload ?? null)
    : (data ?? { detail: item.text ?? null });
  // The item status is the only tool lifecycle source: write it as the tool
  // status so the derivation and the command label follow it.
  const toolStatus = item.kind === "tool" ? TOOL_STATUS_BY_ITEM_STATUS[item.status] : undefined;
  const payload =
    toolStatus !== undefined &&
    rawPayload !== null &&
    typeof rawPayload === "object" &&
    !Array.isArray(rawPayload)
      ? { ...(rawPayload as Record<string, unknown>), status: toolStatus }
      : rawPayload;
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
  // Turn records supply timing, not an extra work-log row.
  if (item.kind === "turn") return null;
  if (item.kind === "reasoning" && (item.text === null || item.text.length === 0)) return null;
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
  };
}

export interface ThreadItemUserContent {
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly skills: ReadonlyArray<ProviderSkillReference>;
  readonly mentions: ReadonlyArray<ProviderMentionReference>;
  readonly origin?: MessageOrigin;
  readonly steered?: true;
}

export function threadItemToUserContent(item: CleanCoreThreadItem): ThreadItemUserContent {
  if (item.kind !== "user")
    return { text: item.text ?? "", attachments: [], skills: [], mentions: [] };
  const data = decodeUserItemData(item.data === null ? null : JSON.parse(item.data));
  return {
    text: item.text ?? "",
    ...data,
    skills: data.skills ?? [],
    mentions: data.mentions ?? [],
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
    ...(content.origin === undefined ? {} : { origin: content.origin }),
    ...(content.steered ? { steered: content.steered } : {}),
    sequence: item.seq,
    turnId: item.turnId === null ? null : TurnId.makeUnsafe(item.turnId),
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
