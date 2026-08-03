import { IconCheck, IconLayoutGrid } from "@tabler/icons-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "~/lib/utils";

export interface AppPickerRowSharedProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: ReactNode;
  selected?: boolean;
}

export function AppPickerRowShared({
  children = "Penkra",
  className,
  icon = <IconLayoutGrid />,
  selected = false,
  ...props
}: AppPickerRowSharedProps) {
  return (
    <button
      aria-pressed={selected}
      className={cn(
        "flex h-[38px] w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2.5 text-[length:var(--app-font-size-ui-lg,13px)] text-[var(--color-text-foreground-secondary)] outline-none hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)] focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)]",
        selected &&
          "bg-[var(--color-background-button-secondary)] text-[var(--color-text-foreground)]",
        className,
      )}
      type="button"
      {...props}
    >
      <span className="inline-flex size-[18px] items-center justify-center [&_svg]:size-[18px]">
        {icon}
      </span>
      <span className="flex-1 truncate text-left">{children}</span>
      {selected ? <IconCheck className="size-4" /> : null}
    </button>
  );
}
