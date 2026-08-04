import type { HTMLAttributes } from "react";

import { ArrowLeftIcon } from "~/lib/icons";
import { CentralIcon } from "~/lib/central-icons";
import { cn } from "~/lib/utils";

export interface SidebarHeaderSharedProps extends HTMLAttributes<HTMLElement> {
  brand?: string;
  onBack?: () => void;
  onClose?: () => void;
}

export function SidebarHeaderShared({
  brand = "Penkra",
  className,
  onBack,
  onClose,
  ...props
}: SidebarHeaderSharedProps) {
  return (
    <header
      className={cn(
        "flex h-[46px] w-60 items-center gap-1.5 bg-transparent pr-2.5 pl-[18px] font-sans",
        className,
      )}
      data-pencil-component="xpOxQ"
      {...props}
    >
      <span className="min-w-0 truncate text-[length:calc(var(--app-font-size-base,12px)*1.1667)] font-bold text-[var(--color-text-foreground)]">
        {brand}
      </span>
      <span className="flex-1" />
      <button
        aria-label={onBack ? "Back to thread" : "Close left panel"}
        className="inline-flex size-4 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-[var(--color-text-foreground-secondary)] outline-none hover:text-[var(--color-text-foreground)] focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)]"
        onClick={onBack ?? onClose}
        type="button"
      >
        {onBack ? (
          <ArrowLeftIcon className="size-4" />
        ) : (
          <CentralIcon className="size-4" name="sidebar-simple-right-wide" />
        )}
      </button>
    </header>
  );
}
