import { IconChevronDown, IconSearch } from "@tabler/icons-react";
import type { HTMLAttributes } from "react";

import { cn } from "~/lib/utils";

export interface SidebarHeaderSharedProps extends HTMLAttributes<HTMLElement> {
  brand?: string;
  onBrand?: () => void;
  onSearch?: () => void;
  showBrandMenu?: boolean;
}

export function SidebarHeaderShared({
  brand = "Penkra",
  className,
  onBrand,
  onSearch,
  showBrandMenu = false,
  ...props
}: SidebarHeaderSharedProps) {
  return (
    <header
      className={cn(
        "flex h-8 w-60 items-center gap-1.5 bg-transparent px-2.5 font-sans",
        className,
      )}
      {...props}
    >
      <button
        className="inline-flex min-w-0 cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-sm font-bold text-[var(--pencil-text-primary)] outline-none focus-visible:ring-1 focus-visible:ring-[var(--pencil-accent-focus)]"
        onClick={onBrand}
        type="button"
      >
        <span className="truncate">{brand}</span>
        {showBrandMenu ? (
          <IconChevronDown className="size-3 text-[var(--pencil-text-secondary)]" />
        ) : null}
      </button>
      <span className="flex-1" />
      <button
        aria-label="Search"
        className="inline-flex size-4 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-[var(--pencil-text-secondary)] outline-none hover:text-[var(--pencil-text-primary)] focus-visible:ring-1 focus-visible:ring-[var(--pencil-accent-focus)]"
        onClick={onSearch}
        type="button"
      >
        <IconSearch className="size-4" />
      </button>
    </header>
  );
}
