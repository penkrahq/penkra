import { forwardRef, type ButtonHTMLAttributes } from "react";

import { cn } from "~/lib/utils";

export type ShowMoreRowProps = ButtonHTMLAttributes<HTMLButtonElement>;

export const ShowMoreRow = forwardRef<HTMLButtonElement, ShowMoreRowProps>(function ShowMoreRow(
  { children = "Show more", className, disabled, type = "button", ...props },
  ref,
) {
  return (
    <button
      className={cn(
        "flex h-[27px] w-full min-w-0 cursor-pointer items-center border-0 bg-transparent pr-2.5 pl-6 font-sans text-[length:var(--app-font-size-ui,12px)] leading-4 font-normal text-[var(--color-text-foreground)] outline-none",
        "disabled:cursor-not-allowed",
        className,
      )}
      data-pencil-component="AnPRU"
      disabled={disabled}
      ref={ref}
      type={type}
      {...props}
    >
      <span
        className="min-w-0 truncate text-left opacity-55 transition-opacity hover:opacity-100"
        data-pencil-node="k16ybr"
      >
        {children}
      </span>
    </button>
  );
});
