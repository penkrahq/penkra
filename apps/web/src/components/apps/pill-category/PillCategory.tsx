import type { ButtonHTMLAttributes } from "react";

import { cn } from "~/lib/utils";

export interface PillCategoryProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  selected?: boolean;
}

export function PillCategory({
  children = "Productivity",
  className,
  selected = false,
  ...props
}: PillCategoryProps) {
  return (
    <button
      aria-pressed={selected}
      className={cn(
        "inline-flex h-7 cursor-pointer items-center justify-center rounded-full border border-[var(--color-border)] bg-transparent px-3 text-xs text-[var(--color-text-foreground-secondary)] outline-none hover:bg-[var(--color-background-button-secondary-hover)] focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)]",
        selected &&
          "border-transparent bg-[var(--color-background-button-primary)] text-[var(--color-text-button-primary)]",
        className,
      )}
      data-pencil-component="tNSs3"
      type="button"
      {...props}
    >
      {children}
    </button>
  );
}
