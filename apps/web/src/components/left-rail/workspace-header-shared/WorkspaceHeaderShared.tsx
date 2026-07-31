import type { ComponentProps, MouseEvent } from "react";

import { ChevronDownIcon, ChevronRightIcon, EllipsisIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { LeftRailRow } from "../row-shared/LeftRailRow";

export interface WorkspaceHeaderSharedProps extends Omit<
  ComponentProps<typeof LeftRailRow>,
  "leading" | "trailing"
> {
  expanded?: boolean;
  onAction?: (event: MouseEvent<HTMLButtonElement>) => void;
}

export function WorkspaceHeaderShared({
  children = "penkra",
  expanded = true,
  onAction,
  state = "default",
  ...props
}: WorkspaceHeaderSharedProps) {
  const Chevron = expanded ? ChevronDownIcon : ChevronRightIcon;
  const showAffordances = state === "hover" || state === "active" || state === "selected";
  return (
    <div className="group/workspace-header relative w-full">
      <LeftRailRow
        aria-expanded={expanded}
        className="gap-3 pr-2.5"
        leading={<Chevron className="size-3" />}
        leadingClassName={cn(
          "hidden size-3.5 group-hover/workspace-header:inline-flex group-focus-within/workspace-header:inline-flex",
          showAffordances && "inline-flex",
        )}
        {...props}
        state={state}
      >
        <span className="font-semibold text-[var(--color-text-foreground-tertiary)]">
          {children}
        </span>
      </LeftRailRow>
      {onAction ? (
        <button
          aria-label="Workspace actions"
          className={cn(
            "absolute top-1/2 right-2.5 inline-flex size-3.5 -translate-y-1/2 cursor-pointer items-center justify-center border-0 bg-[var(--color-background-button-secondary-hover)] p-0 text-[var(--color-text-foreground-secondary)] opacity-0 outline-none",
            "group-hover/workspace-header:opacity-100 hover:text-[var(--color-text-foreground)] focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)]",
            showAffordances && "opacity-100",
          )}
          onClick={(event) => {
            event.stopPropagation();
            onAction(event);
          }}
          type="button"
        >
          <EllipsisIcon className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}
