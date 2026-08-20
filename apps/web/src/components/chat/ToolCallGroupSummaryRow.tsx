// FILE: ToolCallGroupSummaryRow.tsx
// Purpose: Collapsed summary disclosure for a settled run of tool calls
//          ("Ran 2 commands, Edited 2 files"); expands to the individual rows.
// Layer: Web chat presentation component
// Exports: ToolCallGroupSummaryRow
// Depends on: DisclosureRegion/DisclosureChevron (shared disclosure motion)

import type { ReactNode } from "react";

import { DisclosureChevron } from "../ui/DisclosureChevron";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import { extractWebFetchUrl } from "../../lib/toolCallLabel";
import { LinkChipIcon } from "../LinkChipIcon";
import type { ToolCallGroupSummary } from "./toolCallGroup.logic";
import { WorkEntryLeftIcon } from "./TimelineWorkEntryRow";

export function ToolCallGroupSummaryRow(props: {
  summary: ToolCallGroupSummary;
  open: boolean;
  onToggle: (open: boolean) => void;
  fontSizePx: number;
  renderChildren: () => ReactNode;
}) {
  const { summary, open, onToggle, fontSizePx, renderChildren } = props;

  // The collapsed row wears its first entry's icon (favicon for web fetches),
  // so folding a run of tool calls keeps the leading glyph of the row it hides.
  const iconWebFetchUrl = extractWebFetchUrl(summary.iconEntry);

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 py-0.5 text-left text-muted-foreground/70 transition-colors duration-200 hover:text-muted-foreground/90"
        style={{ fontSize: `${fontSizePx}px` }}
        onClick={() => onToggle(!open)}
      >
        <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden>
          {iconWebFetchUrl ? (
            <LinkChipIcon url={iconWebFetchUrl} className="size-3.5" />
          ) : (
            <WorkEntryLeftIcon workEntry={summary.iconEntry} className="size-3.5" />
          )}
        </span>
        <span>{summary.label}</span>
        <DisclosureChevron open={open} className="text-muted-foreground/55" />
      </button>
      <DisclosureRegion open={open}>{open ? renderChildren() : null}</DisclosureRegion>
    </div>
  );
}
