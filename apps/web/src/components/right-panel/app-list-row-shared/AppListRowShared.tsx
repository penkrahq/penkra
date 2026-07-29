import { IconChevronRight } from "@tabler/icons-react";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

import { cn } from "~/lib/utils";

export interface AppListRowSharedProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: ReactNode;
  selected?: boolean;
  shortcut?: string;
}

export const AppListRowShared = forwardRef<HTMLButtonElement, AppListRowSharedProps>(
  function AppListRowShared(
    { children = "GitHub", className, icon, selected = false, shortcut, ...props },
    ref,
  ) {
    return (
      <button
        className={cn(
          "flex min-h-[29px] w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2.5 font-sans text-[13px] text-[var(--color-text-foreground-secondary)] outline-none transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)] focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)] disabled:cursor-not-allowed disabled:text-[var(--color-text-foreground-tertiary)]",
          selected &&
            "bg-[var(--color-background-button-secondary)] text-[var(--color-text-foreground)]",
          className,
        )}
        ref={ref}
        type="button"
        {...props}
      >
        {icon ? (
          <span className="inline-flex size-3.5 items-center justify-center [&_svg]:size-3.5">
            {icon}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-left">{children}</span>
        {shortcut ? (
          <kbd className="font-sans text-[11px] text-[var(--color-text-foreground-tertiary)]">
            {shortcut}
          </kbd>
        ) : (
          <IconChevronRight className="size-3.5 text-[var(--color-text-foreground-tertiary)]" />
        )}
      </button>
    );
  },
);
