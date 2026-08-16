import { type MouseEvent, type ReactNode, useState } from "react";

import { DisclosureSection } from "~/components/ui/DisclosureRegion";

import type { LeftRailRowState } from "../row-shared/LeftRailRow";
import { SpaceHeaderShared } from "../space-header-shared/SpaceHeaderShared";

export interface SpaceGroupSharedProps {
  children?: ReactNode;
  defaultExpanded?: boolean;
  expanded?: boolean;
  hasContent?: boolean;
  header?: ReactNode;
  headerState?: LeftRailRowState;
  label?: string;
  onExpandedChange?: (expanded: boolean) => void;
  onHeaderAction?: (event: MouseEvent<HTMLButtonElement>) => void;
  onHeaderContextMenu?: (event: MouseEvent<HTMLButtonElement>) => void;
}

export function SpaceGroupShared({
  children,
  defaultExpanded = true,
  expanded: expandedProp,
  hasContent: hasContentProp,
  header,
  headerState = "default",
  label = "Personal",
  onExpandedChange,
  onHeaderAction,
  onHeaderContextMenu,
}: SpaceGroupSharedProps) {
  const [uncontrolledExpanded, setUncontrolledExpanded] = useState(defaultExpanded);
  const hasContent = hasContentProp ?? children != null;
  const expanded = hasContent && (expandedProp ?? uncontrolledExpanded);

  const setExpanded = (nextExpanded: boolean) => {
    if (!hasContent) return;
    if (expandedProp === undefined) setUncontrolledExpanded(nextExpanded);
    onExpandedChange?.(nextExpanded);
  };

  return (
    <DisclosureSection
      className="w-full"
      contentClassName="flex flex-col gap-0.5 pt-0.5"
      data-pencil-component="U9o7S"
      hasContent={hasContent}
      header={
        header ?? (
          <SpaceHeaderShared
            actionLabel={`Create folder in ${label}`}
            expanded={expanded}
            {...(onHeaderAction ? { onAction: onHeaderAction } : {})}
            {...(onHeaderContextMenu ? { onContextMenu: onHeaderContextMenu } : {})}
            onClick={() => setExpanded(!expanded)}
            state={headerState}
          >
            {label}
          </SpaceHeaderShared>
        )
      }
      open={expanded}
    >
      {children}
    </DisclosureSection>
  );
}
