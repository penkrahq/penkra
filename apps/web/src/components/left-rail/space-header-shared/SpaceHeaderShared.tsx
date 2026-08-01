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
        className={cn(
          "gap-0 pr-2.5 transition-[padding,color,background-color] duration-[140ms] ease-out",
          "group-hover/space-header:bg-[var(--color-background-button-secondary-hover)] group-hover/space-header:text-[var(--color-text-foreground)] group-focus-within/space-header:bg-[var(--color-background-button-secondary-hover)] group-focus-within/space-header:text-[var(--color-text-foreground)]",
          onAction && "group-hover/space-header:pr-9 group-focus-within/space-header:pr-9",
          showAffordances && onAction && "pr-9",
        )}
        leading={<Chevron className="size-3" />}
        leadingClassName={cn(
          "h-3.5 w-0 overflow-hidden opacity-0 transition-[width,margin,opacity] duration-[140ms] ease-out",
          "group-hover/space-header:mr-3 group-hover/space-header:w-3.5 group-hover/space-header:opacity-100 group-focus-within/space-header:mr-3 group-focus-within/space-header:w-3.5 group-focus-within/space-header:opacity-100",
          showAffordances && "mr-3 w-3.5 opacity-100",
        )}
        {...props}
        state={state}
      >
        <span
          className={cn(
            "font-semibold text-[var(--color-text-foreground-tertiary)] transition-colors duration-[140ms] ease-out group-hover/space-header:text-[var(--color-text-foreground)] group-focus-within/space-header:text-[var(--color-text-foreground)]",
            showAffordances && "text-[var(--color-text-foreground)]",
          )}
        >
          {children}
        </span>
      </LeftRailRow>
      {onAction ? (
        <button
          aria-label={actionLabel ?? `Create thread in ${label}`}
          className={cn(
            "absolute top-1/2 right-2.5 inline-flex size-3.5 -translate-y-1/2 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-[var(--color-text-foreground-secondary)] opacity-0 outline-none transition-[opacity,color] duration-[140ms] ease-out",
            "group-hover/space-header:opacity-100 group-has-[:focus-visible]/space-header:opacity-100 hover:text-[var(--color-text-foreground)] focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)]",
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
