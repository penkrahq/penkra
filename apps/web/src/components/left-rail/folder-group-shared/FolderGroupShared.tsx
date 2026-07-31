"use client";

import type { ProviderKind } from "@synara/contracts";
import { type MouseEvent, type ReactNode, useState } from "react";

import { DisclosureSection } from "~/components/ui/DisclosureRegion";

import { FolderRowShared } from "../folder-row-shared/FolderRowShared";
import type { LeftRailRowState } from "../row-shared/LeftRailRow";
import { ShowMoreRow } from "../show-more-row/ShowMoreRow";
import { ThreadRowShared, type ThreadWorkStatus } from "../thread-row-shared/ThreadRowShared";

export interface FolderGroupThread {
  id: string;
  label: string;
  provider?: ProviderKind | "github";
  state?: LeftRailRowState;
  workStatus?: ThreadWorkStatus;
}

export interface FolderGroupSharedProps {
  children?: ReactNode;
  defaultExpanded?: boolean;
  expanded?: boolean;
  hasContent?: boolean;
  headerState?: LeftRailRowState;
  label?: string;
  onExpandedChange?: (expanded: boolean) => void;
  onHeaderAction?: (event: MouseEvent<HTMLButtonElement>) => void;
  onHeaderContextMenu?: (event: MouseEvent<HTMLButtonElement>) => void;
  onShowMore?: () => void;
  onThreadSelect?: (id: string) => void;
  showMore?: boolean;
  threads?: FolderGroupThread[];
}

export function FolderGroupShared({
  children,
  defaultExpanded = false,
  expanded: expandedProp,
  hasContent: hasContentProp,
  headerState = "default",
  label = "penut",
  onExpandedChange,
  onHeaderAction,
  onHeaderContextMenu,
  onShowMore,
  onThreadSelect,
  showMore = false,
  threads = [],
}: FolderGroupSharedProps) {
  const [uncontrolledExpanded, setUncontrolledExpanded] = useState(defaultExpanded);
  const requestedExpanded = expandedProp ?? uncontrolledExpanded;
  const hasContent = hasContentProp ?? (children != null || threads.length > 0 || showMore);
  const expanded = hasContent && requestedExpanded;

  const setExpanded = (nextExpanded: boolean) => {
    if (!hasContent) return;
    if (expandedProp === undefined) setUncontrolledExpanded(nextExpanded);
    onExpandedChange?.(nextExpanded);
  };

  return (
    <DisclosureSection
      className="w-full"
      contentClassName="pt-0.5"
      data-pencil-component="Shahm"
      hasContent={hasContent}
      header={
        <FolderRowShared
          expanded={expanded}
          state={headerState}
          {...(hasContent ? { onClick: () => setExpanded(!expanded) } : {})}
          {...(onHeaderAction === undefined ? {} : { onAction: onHeaderAction })}
          {...(onHeaderContextMenu === undefined ? {} : { onContextMenu: onHeaderContextMenu })}
        >
          {label}
        </FolderRowShared>
      }
      open={expanded}
    >
      <div className="flex flex-col gap-0.5" data-slot="folder-content">
        {children}
        {threads.map((thread) => (
          <ThreadRowShared
            key={thread.id}
            level="nested"
            onClick={() => onThreadSelect?.(thread.id)}
            {...(thread.provider === undefined ? {} : { harness: thread.provider })}
            {...(thread.state === undefined ? {} : { state: thread.state })}
            {...(thread.workStatus === undefined ? {} : { workStatus: thread.workStatus })}
          >
            {thread.label}
          </ThreadRowShared>
        ))}
        {showMore ? <ShowMoreRow onClick={onShowMore}>Show more</ShowMoreRow> : null}
      </div>
    </DisclosureSection>
  );
}
