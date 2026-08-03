import { IconCircleCheck, IconPackage } from "@tabler/icons-react";
import type { ReactNode } from "react";

import { SwitchShared } from "~/components/foundations/switch-shared/SwitchShared";
import { cn } from "~/lib/utils";

export interface AppCardSharedProps {
  checked?: boolean;
  className?: string;
  description?: string;
  disabled?: boolean;
  icon?: ReactNode;
  name?: string;
  onCheckedChange?: (checked: boolean) => void;
  verified?: boolean;
}

export function AppCardShared({
  checked = false,
  className,
  description = "Sync invoices and reconcile expenses automatically.",
  disabled = false,
  icon = <IconPackage />,
  name = "Ledger",
  onCheckedChange,
  verified = true,
}: AppCardSharedProps) {
  return (
    <article
      aria-disabled={disabled}
      className={cn(
        "flex min-h-[154px] w-[220px] items-center gap-3 rounded-[10px] border border-[var(--color-border)] bg-[var(--color-background-surface)] p-4 font-sans",
        disabled && "opacity-50",
        className,
      )}
      data-pencil-component="Q0YrUi"
    >
      <span className="inline-flex size-[52px] shrink-0 items-center justify-center p-3 text-[var(--color-text-foreground)] [&_svg]:size-7">
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1">
          <strong className="truncate text-[length:calc(var(--app-font-size-base,12px)*1.25)] font-semibold text-[var(--color-text-foreground)]">
            {name}
          </strong>
          {verified ? (
            <IconCircleCheck className="size-3.5 shrink-0 text-[var(--color-text-accent)]" />
          ) : null}
        </span>
        <span className="line-clamp-4 text-[length:var(--app-font-size-ui,12px)] leading-[1.4] text-[var(--color-text-foreground-secondary)]">
          {description}
        </span>
      </span>
      <SwitchShared
        aria-label={`${checked ? "Remove" : "Add"} ${name}`}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onCheckedChange?.(Boolean(next))}
      />
    </article>
  );
}
