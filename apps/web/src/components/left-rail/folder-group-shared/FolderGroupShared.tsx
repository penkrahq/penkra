"use client";

import type { ProviderKind } from "@synara/contracts";
import { useState } from "react";

import { DisclosureSection } from "~/components/ui/DisclosureRegion";

import { FolderStateIcon } from "../folder-state-icon/FolderStateIcon";
import { LeftRailRow, type LeftRailRowState } from "../row-shared/LeftRailRow";
import { ShowMoreRow } from "../show-more-row/ShowMoreRow";
import { ThreadRowShared } from "../thread-row-shared/ThreadRowShared";

export interface FolderGroupThread {
  id: string;
  label: string;
  provider?: ProviderKind;
  state?: LeftRailRowState;
}

export interface FolderGroupSharedProps {
  defaultExpanded?: boolean;
  expanded?: boolean;
  label?: string;
  onExpandedChange?: (expanded: boolean) => void;
  onShowMore?: () => void;
  onThreadSelect?: (id: string) => void;
  showMore?: boolean;
  threads?: FolderGroupThread[];
}

export function FolderGroupShared({
  defaultExpanded = false,
  expanded: expandedProp,
  label = "penut",
  onExpandedChange,
  onShowMore,
  onThreadSelect,
  showMore = false,
  threads = [],
}: FolderGroupSharedProps) {
  const [uncontrolledExpanded, setUncontrolledExpanded] = useState(defaultExpanded);
  const expanded = expandedProp ?? uncontrolledExpanded;

  const setExpanded = (nextExpanded: boolean) => {
    if (expandedProp === undefined) setUncontrolledExpanded(nextExpanded);
    onExpandedChange?.(nextExpanded);
  };

  const hasContent = threads.length > 0 || showMore;

  return (
    <DisclosureSection
      className="w-full"
      contentClassName="pt-0.5"
      data-pencil-component="Shahm"
      hasContent={hasContent}
      header={
        <LeftRailRow
          aria-expanded={expanded}
          className="gap-1.5"
          leading={<FolderStateIcon open={expanded} />}
          leadingClassName="size-3.5"
          onClick={() => setExpanded(!expanded)}
          state={expanded ? "open" : "default"}
        >
          <span className="font-medium">{label}</span>
        </LeftRailRow>
      }
      open={expanded}
    >
      <div className="flex flex-col gap-0.5" data-slot="folder-content">
        {threads.map((thread) => (
          <ThreadRowShared
            key={thread.id}
            onClick={() => onThreadSelect?.(thread.id)}
            {...(thread.provider === undefined ? {} : { harness: thread.provider })}
            {...(thread.state === undefined ? {} : { state: thread.state })}
          >
            {thread.label}
          </ThreadRowShared>
        ))}
        {showMore ? <ShowMoreRow onClick={onShowMore}>Show more</ShowMoreRow> : null}
      </div>
    </DisclosureSection>
  );
}
