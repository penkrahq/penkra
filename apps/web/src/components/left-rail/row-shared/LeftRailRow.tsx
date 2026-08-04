import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

import { cn } from "~/lib/utils";

export type LeftRailRowState =
  | "default"
  | "hover"
  | "active"
  | "selected"
  | "open"
  | "disabled"
  | "focus"
  | "error";

export interface LeftRailRowProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  leading?: ReactNode;
  leadingClassName?: string;
  state?: LeftRailRowState;
  trailing?: ReactNode;
  trailingClassName?: string;
}

export const LeftRailRow = forwardRef<HTMLButtonElement, LeftRailRowProps>(function LeftRailRow(
  {
    children,
    className,
    disabled,
    leading,
    leadingClassName,
    state = "default",
    trailing,
    trailingClassName,
    type = "button",
    ...props
  },
  ref,
) {
  return (
    <button
      className={cn(
        "group/left-rail-row flex h-[27px] w-full min-w-0 cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2.5 font-sans text-[length:var(--app-font-size-ui,12px)] leading-4 font-normal text-[var(--color-text-foreground-secondary)] outline-none transition-colors",
        "hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)] active:bg-transparent active:text-[var(--color-text-foreground)] focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)]",
        state === "hover" &&
          "bg-[var(--color-background-button-secondary-hover)] text-[var(--color-text-foreground)]",
        (state === "active" || state === "selected") &&
          "bg-transparent text-[var(--color-text-foreground)]",
        state === "open" && "text-[var(--color-text-foreground-secondary)]",
        (disabled || state === "disabled") &&
          "cursor-not-allowed bg-transparent text-[var(--color-text-foreground-tertiary)] hover:bg-transparent hover:text-[var(--color-text-foreground-tertiary)]",
        state === "focus" &&
          "bg-[var(--color-background-button-secondary-hover)] text-[var(--color-text-foreground)] ring-1 ring-[var(--color-border-focus)]",
        state === "error" &&
          "bg-[var(--color-background-button-secondary-hover)] text-[var(--color-text-foreground)]",
        className,
      )}
      data-state={state}
      disabled={disabled || state === "disabled"}
      ref={ref}
      type={type}
      {...props}
    >
      {leading ? (
        <span
          className={cn(
            "inline-flex size-4 shrink-0 items-center justify-center",
            leadingClassName,
          )}
          data-slot="left-rail-leading"
        >
          {leading}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate text-left" data-slot="left-rail-label">
        {children}
      </span>
      {trailing ? (
        <span
          className={cn("inline-flex shrink-0 items-center justify-center", trailingClassName)}
          data-slot="left-rail-trailing"
        >
          {trailing}
        </span>
      ) : null}
    </button>
  );
});
