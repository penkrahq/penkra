import { IconChevronDown } from "@tabler/icons-react";
import type { HTMLAttributes, ReactNode } from "react";

import { SearchIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

export interface SidebarHeaderSharedProps extends HTMLAttributes<HTMLElement> {
  brand?: string;
  leading?: ReactNode;
  onBrand?: () => void;
  onSearch?: () => void;
  showBrandMenu?: boolean;
}

export function SidebarHeaderShared({
  brand = "Penkra",
  className,
  leading,
  onBrand,
  onSearch,
  showBrandMenu = false,
  ...props
}: SidebarHeaderSharedProps) {
  return (
    <header
      className={cn(
        "flex h-[46px] w-60 items-center gap-1.5 bg-transparent px-2.5 font-sans",
        className,
      )}
      {...props}
    >
      {leading}
      <button
        className="inline-flex min-w-0 cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-sm font-bold text-[var(--color-text-foreground)] outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)]"
        onClick={onBrand}
        type="button"
      >
        <span className="truncate">{brand}</span>
        {showBrandMenu ? (
          <IconChevronDown className="size-3 text-[var(--color-text-foreground-secondary)]" />
        ) : null}
      </button>
      <span className="flex-1" />
      <button
        aria-label="Search"
        className="inline-flex size-4 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-[var(--color-text-foreground-secondary)] outline-none hover:text-[var(--color-text-foreground)] focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)]"
        onClick={onSearch}
        type="button"
      >
        <SearchIcon className="size-4" />
      </button>
    </header>
  );
}
