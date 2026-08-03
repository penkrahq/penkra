import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

import { cn } from "~/lib/utils";

export interface SettingsNavRowSharedProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: ReactNode;
  selected?: boolean;
}

export const SettingsNavRowShared = forwardRef<HTMLButtonElement, SettingsNavRowSharedProps>(
  function SettingsNavRowShared(
    { children, className, icon, selected = false, type = "button", ...props },
    ref,
  ) {
    return (
      <button
        aria-current={selected ? "page" : undefined}
        className={cn(
          "flex h-9 w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2.5 font-sans text-[length:var(--app-font-size-ui,12px)] text-[var(--color-text-foreground-secondary)] outline-none transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)] focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)] disabled:cursor-not-allowed disabled:text-[var(--color-text-foreground-tertiary)]",
          selected &&
            "bg-[var(--color-background-button-secondary)] text-[var(--color-text-foreground)]",
          className,
        )}
        ref={ref}
        type={type}
        {...props}
      >
        {icon ? (
          <span className="inline-flex size-4 items-center justify-center [&_svg]:size-4">
            {icon}
          </span>
        ) : null}
        <span className="truncate">{children}</span>
      </button>
    );
  },
);
