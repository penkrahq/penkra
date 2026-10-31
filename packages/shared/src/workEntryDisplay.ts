// Pure work-row text used by both the desktop and phone-facing server.
import type { WorkLogEntry } from "./workLog";
import { basenameOfPath } from "./pathNames";
import { resolveSubagentPresentation } from "./subagentPresentation";
import { extractToolArgumentField, isPrefixedToolArgumentSummary } from "./toolArgumentSummary";
import {
  deriveReadableCommandDisplay,
  deriveInlineCommandCall,
  derivePenkraMcpToolTitle,
  normalizeCompactToolLabel,
  normalizeToolTextForComparison,
  isPenkraExecCommandTool,
  type PenkraMcpToolStatus,
} from "./toolCallLabel";

/**
 * Try to extract a clean file path from a detail string that may contain JSON.
 * Handles patterns like:
 *   Read {"file_path":"/Users/foo/bar.ts","offset":10}
 *   {"file_path":"/path/to/file.ts"}
 */
export function extractFilePathFromDetail(detail: string): string | null {
  const plainPathMatch = /^(.+?\.[A-Za-z0-9][A-Za-z0-9._-]*)(?::\d+)?(?::\d+)?$/u.exec(
    detail.trim(),
  );
  if (plainPathMatch?.[1]?.includes("/")) {
    return plainPathMatch[1].trim();
  }
  // "path" is generic enough that a nested match (e.g. inside a config object)
  // may not be the file the tool acted on — only regex-scan truncated JSON.
  return extractToolArgumentField(detail, ["file_path", "filePath", "path", "filename"], {
    fallbackScan: "whenUnparsed",
  });
}

export function workEntryPreview(workEntry: WorkLogEntry): string | null {
  const isFileRelated =
    workEntry.requestKind === "file-read" ||
    workEntry.requestKind === "file-change" ||
    workEntry.itemType === "file_change";

  if (
    isPenkraExecCommandTool({
      toolName: workEntry.toolName,
      title: workEntry.toolTitle,
      fallbackLabel: workEntry.label,
    }) &&
    (workEntry.command || workEntry.rawCommand)
  ) {
    return null;
  }

  if (workEntry.itemType === "command_execution" || workEntry.command || workEntry.rawCommand) {
    const command = workEntry.command ?? workEntry.rawCommand;
    if (command) return deriveReadableCommandDisplay(command).target;
  }

  if (workEntry.preview) return workEntry.preview;

  // Prefer clean basenames from changedFiles
  if (workEntry.changedFiles && workEntry.changedFiles.length > 0) {
    const names = workEntry.changedFiles.map((p) => basenameOfPath(p));
    if (names.length === 1) return names[0]!;
    return `${names.length} files`;
  }

  if (workEntry.itemType === "collab_agent_tool_call" && (workEntry.subagents?.length ?? 0) > 0) {
    if (workEntry.subagentAction?.summaryText) {
      return workEntry.subagentAction.summaryText;
    }
    const labels = workEntry.subagents!.map((subagent) => {
      const presentation = resolveSubagentPresentation({
        nickname: subagent.nickname,
        role: subagent.role,
        title: subagent.title,
        fallbackId: subagent.threadId,
      });
      return (
        presentation.nickname ?? presentation.primaryLabel ?? basenameOfPath(subagent.threadId)
      );
    });
    return labels.length === 1 ? labels[0]! : `${labels.length} subagents`;
  }

  if (workEntry.itemType === "collab_agent_tool_call") {
    return workEntry.detail ?? workEntry.subagentAction?.prompt ?? null;
  }

  // For detail, try to extract a clean file path first
  if (workEntry.detail) {
    const filePath = extractFilePathFromDetail(workEntry.detail);
    if (filePath) return basenameOfPath(filePath);

    // For file-related entries, the heading alone is enough — don't show raw JSON
    if (isFileRelated) return null;

    // For other entries, if the detail looks like raw JSON, skip it
    const trimmedDetail = workEntry.detail.trim();
    if (trimmedDetail.startsWith("{") || trimmedDetail.startsWith("[")) return null;

    // Dynamic/MCP tool calls surface their arguments as `ToolName: {json}` —
    // transport detail, not a human summary. The raw call stays in toolDetails.
    // Failed calls keep their detail inline: it may carry the error text (e.g.
    // an MCP error serialized as `McpError: {json}`), and on a failure more
    // information beats a tidy row.
    if (toolWorkEntryStatus(workEntry) !== "failed" && isPrefixedToolArgumentSummary(trimmedDetail))
      return null;

    const readLinesMatch = /^Read\s+(\d+\s+lines?)$/i.exec(trimmedDetail);
    if (readLinesMatch?.[1]) return readLinesMatch[1];

    // Clean, non-JSON detail — show it
    return trimmedDetail;
  }

  return null;
}

// Provider read tools (e.g. Claude's `Read`) arrive as generic dynamic tool calls
// without a `file-read` requestKind, so match their tool name to surface the search icon
// instead of the generic tool/wrench fallback.
export function isFileReadToolEntry(workEntry: WorkLogEntry): boolean {
  const name = (workEntry.toolName ?? "").toLowerCase().replace(/[^a-z]/g, "");
  return name === "read" || name === "readfile" || name === "viewfile";
}

export function isGitHubMcpToolCall(workEntry: WorkLogEntry): boolean {
  const toolName = workEntry.toolName?.trim().toLowerCase();
  return Boolean(toolName?.startsWith("mcp__codex_apps__github"));
}

// Penkra's agent gateway command gets the Penkra mark instead of the generic
// MCP glyph. Providers may report the same command with their transport prefix
// or as a bare tool name, so presentation normalizes the provider spelling.
export function toolWorkEntryStatus(workEntry: WorkLogEntry): PenkraMcpToolStatus {
  if (workEntry.toolStatus) return workEntry.toolStatus;
  return workEntry.activityKind !== undefined && workEntry.activityKind !== "tool.completed"
    ? "running"
    : "completed";
}

export function isPenkraToolCall(workEntry: WorkLogEntry): boolean {
  return (
    derivePenkraMcpToolTitle({
      toolName: workEntry.toolName,
      title: workEntry.toolTitle,
      fallbackLabel: workEntry.label,
      status: toolWorkEntryStatus(workEntry),
    }) !== null
  );
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

export function toolWorkEntryHeading(workEntry: WorkLogEntry): string {
  const command = workEntry.command ?? workEntry.rawCommand;
  if (
    command &&
    isPenkraExecCommandTool({
      toolName: workEntry.toolName,
      title: workEntry.toolTitle,
      fallbackLabel: workEntry.label,
    })
  ) {
    return deriveInlineCommandCall(command);
  }
  const penkraTitle = derivePenkraMcpToolTitle({
    toolName: workEntry.toolName,
    title: workEntry.toolTitle,
    fallbackLabel: workEntry.label,
    status: toolWorkEntryStatus(workEntry),
  });
  if (penkraTitle) {
    return penkraTitle;
  }
  if (!workEntry.toolTitle) {
    return capitalizePhrase(normalizeCompactToolLabel(workEntry.label));
  }
  return capitalizePhrase(normalizeCompactToolLabel(workEntry.toolTitle));
}

export function combineWorkEntryDisplayText(heading: string, preview: string | null): string {
  if (!preview) {
    return heading;
  }
  return normalizeToolTextForComparison(heading) === normalizeToolTextForComparison(preview)
    ? heading
    : `${heading} ${preview}`;
}
