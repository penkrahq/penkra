import { IconChevronRight } from "@tabler/icons-react";
import type { ReactNode } from "react";

export function ConnectionMethodRowShared({
  ariaLabel,
  icon,
  label,
  onClick,
}: {
  readonly ariaLabel?: string;
  readonly icon: ReactNode;
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <button
      aria-label={ariaLabel}
      className="flex min-h-12 w-full items-center gap-3 px-3.5 text-left hover:bg-[var(--color-background-button-secondary)]"
      data-pencil-component="E5buJ6"
      onClick={onClick}
      type="button"
    >
      {icon}
      <span className="flex-1 text-[13px] font-medium text-[var(--color-text-foreground)]">
        {label}
      </span>
      <IconChevronRight className="size-4 text-[var(--color-text-foreground-tertiary)]" />
    </button>
  );
}
