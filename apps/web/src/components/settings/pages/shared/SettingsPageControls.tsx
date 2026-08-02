import { IconCheck, type Icon } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { useState } from "react";

import { SwitchShared } from "~/components/foundations/switch-shared/SwitchShared";
import { cn } from "~/lib/utils";

export function SettingsTextAction({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      className="shrink-0 cursor-pointer border-0 bg-transparent p-0 text-xs text-[var(--color-text-foreground-secondary)] outline-none hover:text-[var(--color-text-foreground)] focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)]"
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
  return (
    <button
      className="shrink-0 cursor-pointer border-0 bg-transparent p-0 text-xs text-[var(--color-text-foreground-secondary)] outline-none hover:text-[var(--color-text-foreground)] focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)]"
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
  icon: Icon;
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
        <span className="flex items-center gap-1.5 text-[13px] font-medium text-[var(--color-text-foreground)]">
          {label}
          <IconCheck className="size-3.5 text-[var(--color-text-accent)]" />
        </span>
        <span className="mt-0.5 text-xs leading-relaxed text-[var(--color-text-foreground-tertiary)]">
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

export function SettingsConnectorRow({
  defaultChecked = true,
  description,
  icon: RowIcon,
  label,
}: {
  defaultChecked?: boolean;
  description: string;
  icon: Icon;
  label: string;
}) {
  const [checked, setChecked] = useState(defaultChecked);

  return (
    <div className="flex h-[59px] w-full items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-background-surface)] px-4 py-3">
      <span className="inline-flex size-4 shrink-0 items-center justify-center text-[var(--color-text-foreground-secondary)]">
        <RowIcon className="size-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[13px] text-[var(--color-text-foreground)]">{label}</span>
        <span className="mt-0.5 text-xs text-[var(--color-text-foreground-tertiary)]">
          {description}
        </span>
      </span>
      <SwitchShared
        aria-label={`${label} connected`}
        checked={checked}
        onCheckedChange={setChecked}
      />
    </div>
  );
}
