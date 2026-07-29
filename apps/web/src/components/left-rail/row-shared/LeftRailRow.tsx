import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

import { cn } from "~/lib/utils";

export type LeftRailRowState = "default" | "selected" | "open";

export interface LeftRailRowProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  leading?: ReactNode;
  state?: LeftRailRowState;
  trailing?: ReactNode;
}

export const LeftRailRow = forwardRef<HTMLButtonElement, LeftRailRowProps>(function LeftRailRow(
  {
    children,
    className,
    disabled,
    leading,
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
        "group/left-rail-row flex h-[27px] w-full min-w-0 cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 font-sans text-[13px] leading-4 font-normal text-[var(--pencil-text-secondary)] outline-none transition-colors",
        "hover:bg-white/5 hover:text-[var(--pencil-text-primary)] active:bg-[var(--pencil-disabled)] active:text-[var(--pencil-text-primary)] focus-visible:ring-1 focus-visible:ring-[var(--pencil-accent-focus)]",
        state === "selected" && "bg-[var(--pencil-disabled)] text-[var(--pencil-text-primary)]",
        state === "open" && "text-[#c4c8d9]",
        disabled &&
          "cursor-not-allowed bg-transparent text-[var(--pencil-border-hover)] hover:bg-transparent hover:text-[var(--pencil-border-hover)]",
        className,
      )}
      data-state={state}
      disabled={disabled}
      ref={ref}
      type={type}
      {...props}
    >
      {leading ? (
        <span className="inline-flex size-4 shrink-0 items-center justify-center [&_svg]:size-full">
          {leading}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate text-left">{children}</span>
      {trailing ? (
        <span className="inline-flex shrink-0 items-center justify-center">{trailing}</span>
      ) : null}
    </button>
  );
});
