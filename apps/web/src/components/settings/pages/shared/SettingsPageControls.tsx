import { IconCheck } from "@tabler/icons-react";
import { useState, type ReactNode } from "react";

import { SwitchShared } from "~/components/foundations/switch-shared/SwitchShared";
import { cn } from "~/lib/utils";

export function SettingsTextAction({
  children,
  onClick,
  tone = "default",
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: "default" | "destructive";
}) {
  const className = cn(
    "shrink-0 border-0 bg-transparent p-0 text-[length:var(--app-font-size-ui,12px)]",
    tone === "destructive"
      ? "text-[var(--color-text-destructive)] hover:text-[var(--color-text-destructive)]"
      : "text-[var(--color-text-foreground-secondary)] hover:text-[var(--color-text-foreground)]",
  );

  if (!onClick) return <span className={className}>{children}</span>;

  return (
    <button
      className={cn(
        className,
        "cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)]",
      )}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

export function SettingsValueAction({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick?: () => void;
}) {
  const className =
    "shrink-0 border-0 bg-transparent p-0 text-[length:var(--app-font-size-ui,12px)] text-[var(--color-text-foreground-secondary)]";

  if (!onClick) return <span className={className}>{children} ›</span>;

  return (
    <button
      className={cn(
        className,
        "cursor-pointer outline-none hover:text-[var(--color-text-foreground)] focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)]",
      )}
      onClick={onClick}
      type="button"
    >
      {children} ›
    </button>
  );
}

export function SettingsInstalledRow({
  checked,
  defaultChecked = true,
  description,
  disabled = false,
  icon: RowIcon,
  label,
  multiline = false,
  onCheckedChange,
}: {
  checked?: boolean;
  defaultChecked?: boolean;
  description: string;
  disabled?: boolean;
  icon: typeof IconCheck;
  label: string;
  multiline?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}) {
  const [uncontrolledChecked, setUncontrolledChecked] = useState(defaultChecked);
  const resolvedChecked = checked ?? uncontrolledChecked;

  return (
    <div
      className={cn(
        "flex min-h-[84px] items-center gap-3 rounded-[10px] border border-[var(--color-border)] bg-[var(--color-background-surface)] p-4",
        multiline && "min-h-[86px]",
      )}
    >
      <span className="inline-flex size-[52px] shrink-0 items-center justify-center text-[var(--color-text-foreground-secondary)]">
        <RowIcon className="size-7" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-1.5 text-[length:var(--app-font-size-ui-lg,13px)] font-medium text-[var(--color-text-foreground)]">
          {label}
          <IconCheck className="size-3.5 text-[var(--color-text-accent)]" />
        </span>
        <span className="mt-0.5 text-[length:var(--app-font-size-ui,12px)] leading-relaxed text-[var(--color-text-foreground-tertiary)]">
          {description}
        </span>
      </span>
      <SwitchShared
        aria-label={`${label} installed`}
        checked={resolvedChecked}
        disabled={disabled}
        onCheckedChange={(nextChecked) => {
          if (checked === undefined) setUncontrolledChecked(nextChecked);
          onCheckedChange?.(nextChecked);
        }}
      />
    </div>
  );
}
