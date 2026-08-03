import { IconTrash, IconUser } from "@tabler/icons-react";
import type { HTMLAttributes } from "react";

export interface ConnectionRowSharedProps extends HTMLAttributes<HTMLDivElement> {
  detail?: string;
  label?: string;
  onDelete?: () => void;
}

export function ConnectionRowShared({
  detail = "Connected with Claude",
  label = "sarah@example.com",
  onDelete,
  ...props
}: ConnectionRowSharedProps) {
  return (
    <div
      className="flex min-h-[58px] w-full items-center gap-3 border-b border-[var(--color-border)] font-sans"
      {...props}
    >
      <IconUser className="size-4 text-[var(--color-text-foreground-secondary)]" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[length:var(--app-font-size-ui-lg,13px)] text-[var(--color-text-foreground)]">
          {label}
        </span>
        <span className="truncate text-[length:var(--app-font-size-ui,12px)] text-[var(--color-text-foreground-tertiary)]">
          {detail}
        </span>
      </span>
      <button
        aria-label={`Remove ${label}`}
        className="inline-flex size-7 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-[var(--color-text-foreground-tertiary)] outline-none hover:text-destructive focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)]"
        onClick={onDelete}
        type="button"
      >
        <IconTrash className="size-3.5" />
      </button>
    </div>
  );
}
