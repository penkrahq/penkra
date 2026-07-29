import { IconRefresh } from "@tabler/icons-react";
import type { ComponentProps } from "react";

import { BranchIcon } from "../branch-icon/BranchIcon";
import { LeftRailRow } from "../row-shared/LeftRailRow";

export interface ThreadRowBaseProps
  extends Omit<ComponentProps<typeof LeftRailRow>, "leading" | "trailing"> {
  refreshing?: boolean;
}

export function ThreadRowBase({
  children = "Analyze PostHog user…",
  refreshing = false,
  ...props
}: ThreadRowBaseProps) {
  return (
    <LeftRailRow
      className="pl-6"
      leading={<BranchIcon />}
      trailing={
        refreshing ? (
          <IconRefresh aria-label="Refreshing" className="size-[13px] animate-spin" />
        ) : null
      }
      {...props}
    >
      {children}
    </LeftRailRow>
  );
}
