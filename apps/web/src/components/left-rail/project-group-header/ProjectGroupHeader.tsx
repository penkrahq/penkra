import { IconChevronDown, IconChevronRight } from "@tabler/icons-react";
import type { ComponentProps } from "react";

import { LeftRailRow } from "../row-shared/LeftRailRow";

export interface ProjectGroupHeaderProps extends Omit<
  ComponentProps<typeof LeftRailRow>,
  "leading"
> {
  expanded?: boolean;
}

export function ProjectGroupHeader({
  children = "Projects",
  expanded = true,
  state = "default",
  ...props
}: ProjectGroupHeaderProps) {
  const Chevron = expanded ? IconChevronDown : IconChevronRight;
  return (
    <LeftRailRow
      aria-expanded={expanded}
      className="h-7"
      leading={<Chevron className="!size-3" />}
      {...props}
      state={expanded ? "open" : state}
    >
      {children}
    </LeftRailRow>
  );
}
