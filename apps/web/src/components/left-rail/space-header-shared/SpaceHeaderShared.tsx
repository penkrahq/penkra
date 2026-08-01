import type { ComponentProps, MouseEvent } from "react";

import { ChevronDownIcon, ChevronRightIcon, NewThreadIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

import { LeftRailRow } from "../row-shared/LeftRailRow";

export interface SpaceHeaderSharedProps extends Omit<
  ComponentProps<typeof LeftRailRow>,
  "leading" | "trailing"
> {
  actionLabel?: string;
  expanded?: boolean;
  onAction?: (event: MouseEvent<HTMLButtonElement>) => void;
}

export function SpaceHeaderShared({
  actionLabel,
  children = "Personal",
  expanded = true,
  onAction,
  state = "default",
  ...props
}: SpaceHeaderSharedProps) {
  const Chevron = expanded ? ChevronDownIcon : ChevronRightIcon;
  const showAffordances = state === "hover" || state === "focus";
  const label = typeof children === "string" ? children : "this space";

  return (
    <div className="group/space-header relative w-full">
      <LeftRailRow
        aria-expanded={expanded}
        className="gap-3 pr-2.5"
        leading={<Chevron className="size-3" />}
        leadingClassName={cn(
          "hidden size-3.5 group-hover/space-header:inline-flex group-focus-within/space-header:inline-flex",
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
          aria-label={actionLabel ?? `Create thread in ${label}`}
          className={cn(
            "absolute top-1/2 right-2.5 inline-flex size-3.5 -translate-y-1/2 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-[var(--color-text-foreground-secondary)] opacity-0 outline-none",
            "group-hover/space-header:opacity-100 hover:text-[var(--color-text-foreground)] focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)]",
            showAffordances && "opacity-100",
          )}
          onClick={(event) => {
            event.stopPropagation();
            onAction(event);
          }}
          type="button"
        >
          <NewThreadIcon className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}
