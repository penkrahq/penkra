import { IconChevronDown, IconChevronRight, IconPlus } from "@tabler/icons-react";
import type { ComponentProps } from "react";

import { LeftRailRow } from "../row-shared/LeftRailRow";

export interface WorkspaceHeaderSharedProps
  extends Omit<ComponentProps<typeof LeftRailRow>, "leading" | "trailing"> {
  expanded?: boolean;
  onAdd?: () => void;
}

export function WorkspaceHeaderShared({
  children = "penkra",
  expanded = true,
  onAdd,
  ...props
}: WorkspaceHeaderSharedProps) {
  const Chevron = expanded ? IconChevronDown : IconChevronRight;
  return (
    <div className="group/workspace-header relative w-full">
      <LeftRailRow
        aria-expanded={expanded}
        className="pr-7"
        leading={<Chevron />}
        state={expanded ? "open" : props.state}
        {...props}
      >
        {children}
      </LeftRailRow>
      {onAdd ? (
        <button
          aria-label="Add to workspace"
          className="absolute top-1/2 right-2 inline-flex size-3.5 -translate-y-1/2 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-[var(--color-text-foreground-secondary)] opacity-0 outline-none group-hover/workspace-header:opacity-100 hover:text-[var(--color-text-foreground)] focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)]"
          onClick={onAdd}
          type="button"
        >
          <IconPlus className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}
