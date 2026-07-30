import { IconChevronDown, IconChevronRight, IconDots } from "@tabler/icons-react";
import type { ComponentProps } from "react";

import { LeftRailRow } from "../row-shared/LeftRailRow";

export interface DisclosureRowSharedProps extends Omit<
  ComponentProps<typeof LeftRailRow>,
  "leading" | "trailing"
> {
  expanded?: boolean;
  showTrailing?: boolean;
}

export function DisclosureRowShared({
  children = "penkra",
  expanded = false,
  showTrailing = false,
  state = "default",
  ...props
}: DisclosureRowSharedProps) {
  const Chevron = expanded ? IconChevronDown : IconChevronRight;

  return (
    <LeftRailRow
      aria-expanded={expanded}
      leading={<Chevron className="size-3.5" />}
      leadingClassName="size-3.5"
      state={expanded ? "open" : state}
      trailing={showTrailing ? <IconDots className="size-3.5" /> : null}
      {...props}
    >
      <span className="font-semibold">{children}</span>
    </LeftRailRow>
  );
}
