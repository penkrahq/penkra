import { IconChevronRight } from "@tabler/icons-react";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

import { cn } from "~/lib/utils";

export interface ComposerMenuRowProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  leading?: ReactNode;
}

export const ComposerMenuRow = forwardRef<HTMLButtonElement, ComposerMenuRowProps>(
  function ComposerMenuRow({ children, className, leading, type = "button", ...props }, ref) {
    return (
      <button
        className={cn(
          "flex h-[29px] w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2.5 font-sans text-[13px] text-[var(--color-text-foreground-secondary)] outline-none transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)] focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)]",
          className,
        )}
        ref={ref}
        type={type}
        {...props}
      >
        {leading ? <span className="inline-flex size-3.5 items-center justify-center">{leading}</span> : null}
        <span className="min-w-0 flex-1 truncate text-left">{children}</span>
        <IconChevronRight className="size-3.5 text-[var(--color-text-foreground-tertiary)]" />
      </button>
    );
  },
);
