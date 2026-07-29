import { IconCheck } from "@tabler/icons-react";

import { cn } from "~/lib/utils";

export const themePresetNames = [
  "GitHub",
  "Codex",
  "Catppuccin",
  "Everforest",
  "Solarized",
  "Vercel",
] as const;

export type ThemePresetName = (typeof themePresetNames)[number];

export interface MenuThemePickerProps {
  className?: string;
  onValueChange?: (value: ThemePresetName) => void;
  value?: ThemePresetName;
}

export function MenuThemePicker({
  className,
  onValueChange,
  value = "GitHub",
}: MenuThemePickerProps) {
  return (
    <div
      aria-label="Theme presets"
      className={cn(
        "flex w-[180px] flex-col gap-0.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-background-surface-raised)] p-1 shadow-[0_6px_18px_#0006]",
        className,
      )}
      data-pencil-component="q9tPr"
      role="listbox"
    >
      {themePresetNames.map((name) => {
        const selected = value === name;
        return (
          <button
            aria-selected={selected}
            className={cn(
              "flex h-7 w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 text-xs text-[var(--color-text-foreground-secondary)] outline-none hover:bg-[var(--color-background-button-secondary-hover)] focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)]",
              selected &&
                "bg-[var(--color-background-button-secondary)] text-[var(--color-text-foreground)]",
            )}
            key={name}
            onClick={() => onValueChange?.(name)}
            role="option"
            type="button"
          >
            <span
              className={cn(
                "inline-flex size-[18px] items-center justify-center rounded text-[9px] font-bold text-[var(--color-text-accent)]",
                selected
                  ? "bg-[var(--color-text-accent)] text-[var(--color-text-on-accent)]"
                  : "bg-[var(--color-background-accent)]",
              )}
            >
              Aa
            </span>
            <span className="flex-1 text-left">{name}</span>
            {selected ? <IconCheck className="size-3 text-[var(--color-text-accent)]" /> : null}
          </button>
        );
      })}
    </div>
  );
}
