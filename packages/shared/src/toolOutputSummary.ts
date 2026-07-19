// FILE: toolOutputSummary.ts
// Purpose: Produces compact display summaries from provider tool rawOutput payloads.
// Layer: Shared runtime utility
// Exports: summarizeToolRawOutput, extractToolRawOutputText, countTextLines

import { pluralize } from "./text";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function countTextLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }
  return content.replace(/\r?\n$/, "").split(/\r?\n/).length;
}

/**
 * Extracts the complete human-readable text carried by a provider tool result.
 * ACP providers commonly encode terminal output as an array of content parts,
 * while older integrations use a string or a record field.
 */
export function extractToolRawOutputText(rawOutput: unknown): string | undefined {
  if (typeof rawOutput === "string") {
    return rawOutput.trim().length > 0 ? rawOutput : undefined;
  }
  if (Array.isArray(rawOutput)) {
    const parts = rawOutput
      .map(extractToolRawOutputText)
      .filter((part): part is string => part !== undefined);
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  if (!isRecord(rawOutput)) {
    return undefined;
  }
  for (const key of ["text", "stdout", "output", "content"] as const) {
    const text = extractToolRawOutputText(rawOutput[key]);
    if (text) {
      return text;
    }
  }
  return undefined;
}

export function summarizeToolRawOutput(rawOutput: unknown): string | undefined {
  const record = isRecord(rawOutput) ? rawOutput : undefined;
  const totalFiles = record?.totalFiles;
  if (typeof totalFiles === "number" && Number.isInteger(totalFiles) && totalFiles >= 0) {
    const suffix = record?.truncated === true ? " (truncated)" : "";
    return `${totalFiles} ${pluralize(totalFiles, "file")} found${suffix}`;
  }
  if (typeof record?.content === "string") {
    const lineCount = countTextLines(record.content);
    return `Read ${lineCount} ${pluralize(lineCount, "line")}`;
  }
  const text = extractToolRawOutputText(rawOutput)?.trim();
  return text ? (text.split(/\r?\n/, 1)[0]?.trim() ?? undefined) : undefined;
}
