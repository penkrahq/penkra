// Display metadata for one stored tool item, using the same derivation and
// presentation rules as the desktop timeline.
import type { CleanCoreThreadItem } from "@penkra/contracts";
import { describeLinkChip } from "./linkChips";
import { threadItemToActivity } from "./threadItemActivity";
import { deriveWorkLogEntries, type WorkLogEntry } from "./workLog";
import {
  classifyToolCallSummaryCategory,
  entryFileKeys,
  isSummarizableToolCallEntry,
  type ToolCallSummaryCategory,
} from "./toolCallGroup";
import {
  extractWebFetchUrl,
  resolveCommandVisualKind,
  sanitizePenkraMcpToolPreview,
} from "./toolCallLabel";
import {
  combineWorkEntryDisplayText,
  isFileReadToolEntry,
  isGitHubMcpToolCall,
  isPenkraToolCall,
  toolWorkEntryHeading,
  toolWorkEntryStatus,
  workEntryPreview,
} from "./workEntryDisplay";

export type PhoneToolIcon =
  | "terminal"
  | "edit"
  | "read"
  | "search"
  | "agent"
  | "penkra"
  | "web"
  | "tool";
export interface ToolItemDisplay {
  label: string;
  category: ToolCallSummaryCategory;
  icon: PhoneToolIcon;
  host?: string;
  /** File identity lets the phone count distinct reads/edits like the desktop. */
  fileKeys?: ReadonlyArray<string>;
  summarizable: boolean;
}

function iconForWorkEntry(entry: WorkLogEntry, webUrl: string | null): PhoneToolIcon {
  if (webUrl) return "web";
  if (!isGitHubMcpToolCall(entry) && isPenkraToolCall(entry)) return "penkra";
  if (entry.requestKind === "file-read" || isFileReadToolEntry(entry)) return "read";
  if (entry.requestKind === "file-change" || entry.itemType === "file_change") return "edit";
  if (entry.itemType === "web_search") return "search";
  if (entry.itemType === "collab_agent_tool_call") return "agent";
  const command = entry.command ?? entry.rawCommand;
  if (entry.requestKind === "command" || entry.itemType === "command_execution" || command) {
    return command && resolveCommandVisualKind(command) === "inspect" ? "search" : "terminal";
  }
  return "tool";
}

export function toolItemDisplay(item: CleanCoreThreadItem): ToolItemDisplay | null {
  if (item.kind !== "tool") return null;
  const entry = deriveWorkLogEntries([threadItemToActivity(item)], undefined)[0];
  if (!entry) {
    return { label: item.text ?? "Tool", category: "other", icon: "tool", summarizable: false };
  }
  const webUrl = extractWebFetchUrl(entry);
  const heading = toolWorkEntryHeading(entry);
  const rawPreview = workEntryPreview(entry);
  const preview =
    !isGitHubMcpToolCall(entry) && isPenkraToolCall(entry)
      ? sanitizePenkraMcpToolPreview({
          preview: rawPreview,
          heading,
          status: toolWorkEntryStatus(entry),
        })
      : rawPreview;
  const label = webUrl
    ? describeLinkChip(webUrl).label
    : combineWorkEntryDisplayText(heading, preview);
  let host: string | undefined;
  if (webUrl) {
    try {
      host = new URL(webUrl).host || undefined;
    } catch {
      /* Keep malformed tool data readable. */
    }
  }
  const category = classifyToolCallSummaryCategory(entry);
  const fileKeys = category === "edit" || category === "read" ? entryFileKeys(entry) : [];
  return {
    label,
    category,
    icon: iconForWorkEntry(entry, webUrl),
    ...(host ? { host } : {}),
    ...(fileKeys.length > 0 ? { fileKeys } : {}),
    summarizable: isSummarizableToolCallEntry(entry),
  };
}
