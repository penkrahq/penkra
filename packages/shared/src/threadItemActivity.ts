// Shared conversion of stored transcript rows to canonical work activities.
import {
  EventId,
  TurnId,
  type CleanCoreThreadItem,
  type OrchestrationThreadActivity,
} from "@penkra/contracts";
import type { PenkraMcpToolStatus } from "./toolCallLabel";

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

function normalizeKind(
  value: unknown,
  itemKind: CleanCoreThreadItem["kind"],
  status: string,
): string {
  // A tool item's lifecycle is its item status, so a settled item derives
  // tool.completed even if its original data still says tool.started.
  switch (itemKind) {
    case "tool":
      return status === "running" ? "tool.updated" : "tool.completed";
    case "question":
      return `question.${status}`;
    case "notice":
      return typeof value === "string" && value.length > 0 ? value : "runtime.warning";
    case "user":
    case "text":
    case "turn":
      return itemKind;
    default: {
      const unhandled: never = itemKind;
      throw new Error(`Unhandled transcript kind: ${unhandled}`);
    }
  }
}

function normalizeSummary(value: unknown, text: string | null): string {
  return typeof value === "string" && value.length > 0 ? value : (text ?? "");
}

/**
 * Rebuild the canonical activity for a tool/notice item. A truncated or
 * non-JSON `data` copy (an old OpenCode task result) still renders through
 * TimelineWorkEntryRow with the item text as its detail.
 */
export const TOOL_STATUS_BY_ITEM_STATUS: Record<string, PenkraMcpToolStatus> = {
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
    id: EventId.make(item.sourceId),
    tone: normalizeTone(data?.tone, item.kind),
    kind: normalizeKind(data?.kind, item.kind, item.status),
    summary: normalizeSummary(data?.summary, item.text),
    payload: payload as OrchestrationThreadActivity["payload"],
    turnId: item.turnId === null ? null : TurnId.make(item.turnId),
    sequence: item.seq,
    createdAt: item.sourceId === "context-window:latest" ? item.updatedAt : item.createdAt,
  };
}
