import { PinFilledIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

export interface PinBadgeSharedProps {
  className?: string;
}

/** A layout-neutral status badge overlaid on the bottom-right of a row identity icon. */
export function PinBadgeShared({ className }: PinBadgeSharedProps) {
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute -right-1 -bottom-1 inline-flex size-[10px] items-center justify-center rounded-full bg-[var(--color-background-surface)] text-[var(--color-text-foreground-secondary)]",
        className,
      )}
      data-slot="pin-badge"
    >
      <PinFilledIcon className="size-[6.5px]" />
    </span>
  );
}
