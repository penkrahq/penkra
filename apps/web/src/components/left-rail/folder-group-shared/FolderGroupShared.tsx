"use client";

import type { ProviderKind } from "@synara/contracts";
import { IconChevronDown, IconChevronRight, IconFolder, IconFolderOpen } from "@tabler/icons-react";
import { useState } from "react";

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

  const Chevron = expanded ? IconChevronDown : IconChevronRight;
  const Folder = expanded ? IconFolderOpen : IconFolder;

  return (
    <section className="w-full" data-pencil-component="Shahm">
      <LeftRailRow
        aria-expanded={expanded}
        leading={
          <span className="relative inline-flex size-4 items-center justify-center">
            <Folder className="size-3.5" />
            <Chevron className="absolute -left-2 size-2.5" />
          </span>
        }
        onClick={() => setExpanded(!expanded)}
        state={expanded ? "open" : "default"}
      >
        <span className="font-medium">{label}</span>
      </LeftRailRow>
      {expanded ? (
        <div className="mt-0.5 flex flex-col gap-0.5" data-slot="folder-content">
          {threads.map((thread) => (
            <ThreadRowShared
              key={thread.id}
              onClick={() => onThreadSelect?.(thread.id)}
              provider={thread.provider}
              state={thread.state}
            >
              {thread.label}
            </ThreadRowShared>
          ))}
          {showMore ? <ShowMoreRow onClick={onShowMore}>Show more</ShowMoreRow> : null}
        </div>
      ) : null}
    </section>
  );
}
