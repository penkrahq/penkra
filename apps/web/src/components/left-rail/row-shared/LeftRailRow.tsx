import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

import { cn } from "~/lib/utils";

export type LeftRailRowState = "default" | "selected" | "open";

export interface LeftRailRowProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  leading?: ReactNode;
  leadingClassName?: string;
  state?: LeftRailRowState;
  trailing?: ReactNode;
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
    type = "button",
    ...props
  },
  ref,
) {
  return (
    <button
      className={cn(
        "group/left-rail-row flex h-[27px] w-full min-w-0 cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2.5 font-sans text-[13px] leading-4 font-normal text-[var(--color-text-foreground-secondary)] outline-none transition-colors",
        "hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)] active:bg-[var(--color-background-button-secondary-active)] active:text-[var(--color-text-foreground)] focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)]",
        state === "selected" &&
          "bg-[var(--color-background-button-secondary-active)] text-[var(--color-text-foreground)]",
        state === "open" && "text-[var(--color-text-foreground-secondary)]",
        disabled &&
          "cursor-not-allowed bg-transparent text-[var(--color-text-foreground-tertiary)] hover:bg-transparent hover:text-[var(--color-text-foreground-tertiary)]",
        className,
      )}
      data-state={state}
      disabled={disabled}
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
        <span className="inline-flex shrink-0 items-center justify-center">{trailing}</span>
      ) : null}
    </button>
  );
});
