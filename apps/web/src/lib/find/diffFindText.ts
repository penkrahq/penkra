// FILE: diffFindText.ts
// Purpose: Builds searchable text and exact rendered-line anchors for virtualized Pierre diffs.
// Layer: Web application infrastructure

import type { FileDiffMetadata } from "@pierre/diffs/react";

export interface DiffFindLine {
  readonly text: string;
  readonly renderedLineIndex: number | null;
}

export interface DiffFindText {
  readonly text: string;
  readonly lines: readonly DiffFindLine[];
  readonly lineStartOffsets: readonly number[];
}

function fileHeaderLines(file: FileDiffMetadata): DiffFindLine[] {
  const names =
    file.prevName && file.prevName !== file.name ? [file.prevName, file.name] : [file.name];
  return names.map((text) => ({ text, renderedLineIndex: null }));
}

function unifiedHunkLines(file: FileDiffMetadata, hunkIndex: number): DiffFindLine[] {
  const hunk = file.hunks[hunkIndex]!;
  const lines: DiffFindLine[] = [];
  let renderedLineIndex = hunk.unifiedLineStart;
  if (hunk.hunkSpecs || hunk.hunkContext) {
    lines.push({
      text: [hunk.hunkSpecs, hunk.hunkContext].filter(Boolean).join(" "),
      renderedLineIndex: null,
    });
  }
  for (const content of hunk.hunkContent) {
    if (content.type === "context") {
      for (let index = 0; index < content.lines; index += 1) {
        lines.push({
          text: file.additionLines[content.additionLineIndex + index] ?? "",
          renderedLineIndex,
        });
        renderedLineIndex += 1;
      }
      continue;
    }
    for (let index = 0; index < content.deletions; index += 1) {
      lines.push({
        text: file.deletionLines[content.deletionLineIndex + index] ?? "",
        renderedLineIndex,
      });
      renderedLineIndex += 1;
    }
    for (let index = 0; index < content.additions; index += 1) {
      lines.push({
        text: file.additionLines[content.additionLineIndex + index] ?? "",
        renderedLineIndex,
      });
      renderedLineIndex += 1;
    }
  }
  return lines;
}

function splitHunkLines(file: FileDiffMetadata, hunkIndex: number): DiffFindLine[] {
  const hunk = file.hunks[hunkIndex]!;
  const lines: DiffFindLine[] = [];
  let renderedLineIndex = hunk.splitLineStart;
  if (hunk.hunkSpecs || hunk.hunkContext) {
    lines.push({
      text: [hunk.hunkSpecs, hunk.hunkContext].filter(Boolean).join(" "),
      renderedLineIndex: null,
    });
  }
  for (const content of hunk.hunkContent) {
    if (content.type === "context") {
      for (let index = 0; index < content.lines; index += 1) {
        lines.push({
          text: file.additionLines[content.additionLineIndex + index] ?? "",
          renderedLineIndex,
        });
        renderedLineIndex += 1;
      }
      continue;
    }
    const rowCount = Math.max(content.deletions, content.additions);
    for (let index = 0; index < rowCount; index += 1) {
      const deletion =
        index < content.deletions
          ? (file.deletionLines[content.deletionLineIndex + index] ?? "")
          : "";
      const addition =
        index < content.additions
          ? (file.additionLines[content.additionLineIndex + index] ?? "")
          : "";
      lines.push({
        text: deletion && addition ? `${deletion}\t${addition}` : deletion || addition,
        renderedLineIndex,
      });
      renderedLineIndex += 1;
    }
  }
  return lines;
}

export function buildDiffFindText(
  file: FileDiffMetadata,
  options: { collapsed: boolean; mode: "stacked" | "split" },
): DiffFindText {
  const lines = fileHeaderLines(file);
  if (!options.collapsed) {
    for (let hunkIndex = 0; hunkIndex < file.hunks.length; hunkIndex += 1) {
      lines.push(
        ...(options.mode === "split"
          ? splitHunkLines(file, hunkIndex)
          : unifiedHunkLines(file, hunkIndex)),
      );
    }
  }
  const lineStartOffsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStartOffsets.push(offset);
    offset += line.text.length + 1;
  }
  return {
    text: lines.map((line) => line.text).join("\n"),
    lines,
    lineStartOffsets,
  };
}

export function diffFindRenderedLineForOffset(model: DiffFindText, offset: number): number | null {
  for (let index = model.lines.length - 1; index >= 0; index -= 1) {
    if (offset >= model.lineStartOffsets[index]!) {
      return model.lines[index]!.renderedLineIndex;
    }
  }
  return null;
}
