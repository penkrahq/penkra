import { cn } from "~/lib/utils";

import { ComposerMenuRow } from "../composer-menu-row/ComposerMenuRow";

const quickSettings = ["Model", "Effort", "Speed", "Advanced"] as const;

export type QuickSettingName = (typeof quickSettings)[number];

export interface PopoverQuickSettingsProps {
  className?: string;
  onSelect?: (setting: QuickSettingName) => void;
}

export function PopoverQuickSettings({
  className,
  onSelect,
}: PopoverQuickSettingsProps) {
  return (
    <div
      aria-label="Quick settings"
      className={cn(
        "flex w-[200px] flex-col gap-px rounded-[10px] border border-[var(--color-border)] bg-[var(--color-background-elevated-primary-opaque)] p-1.5",
        className,
      )}
      data-pencil-component="e5zUfJ"
      role="menu"
    >
      {quickSettings.map((setting) => (
        <ComposerMenuRow
          key={setting}
          onClick={() => onSelect?.(setting)}
          role="menuitem"
        >
          {setting}
        </ComposerMenuRow>
      ))}
    </div>
  );
}
