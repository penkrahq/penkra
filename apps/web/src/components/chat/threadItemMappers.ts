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
  type OrchestrationThreadActivity,
  type ProviderMentionReference,
  type ProviderSkillReference,
  type TurnDispatchMode,
  type UserInputQuestion,
} from "@penkra/contracts";
import { EventId, TurnId } from "@penkra/contracts";
import type { CleanCoreThreadItem } from "@penkra/contracts";

import type { PendingUserInput } from "../../pendingInteractionDerivation";
import type { ChatAttachment } from "../../types";
import { deriveWorkLogEntries, type WorkLogEntry } from "../../workLog";

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
  return {
    text: item.text ?? "",
    attachments,
    skills,
    mentions,
    ...(dispatchMode ? { dispatchMode } : {}),
    ...(dispatchOrigin ? { dispatchOrigin } : {}),
  };
}
