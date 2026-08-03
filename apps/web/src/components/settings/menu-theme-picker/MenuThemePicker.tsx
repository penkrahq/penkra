import { IconCheck } from "@tabler/icons-react";

import { getAvailableCodeThemes, type ThemeVariant } from "~/theme/theme.logic";
import { cn } from "~/lib/utils";

export interface MenuThemePickerProps {
  className?: string;
  mode?: ThemeVariant;
  onValueChange?: (codeThemeId: string) => void;
  value?: string;
}

export function MenuThemePicker({
  className,
  mode = "light",
  onValueChange,
  value = "codex",
}: MenuThemePickerProps) {
  const options = getAvailableCodeThemes(mode);
  return (
    <div
      aria-label={`${mode === "dark" ? "Dark" : "Light"} theme presets`}
      className={cn(
        "flex max-h-80 w-[180px] flex-col gap-0.5 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-background-surface-raised)] p-1 shadow-[0_6px_18px_#0006]",
        className,
      )}
      data-pencil-component="q9tPr"
      role="listbox"
    >
      {options.map((option) => {
        const selected = value === option.id;
        return (
          <button
            aria-selected={selected}
            className={cn(
              "flex h-7 w-full shrink-0 cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 text-[length:var(--app-font-size-ui,12px)] text-[var(--color-text-foreground-secondary)] outline-none hover:bg-[var(--color-background-button-secondary-hover)] focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)]",
              selected &&
                "bg-[var(--color-background-button-secondary)] text-[var(--color-text-foreground)]",
            )}
            key={option.id}
            onClick={() => onValueChange?.(option.id)}
            role="option"
            type="button"
          >
            <span
              className={cn(
                "inline-flex size-[18px] items-center justify-center rounded text-[length:var(--app-font-size-ui-2xs,9px)] font-bold text-[var(--color-text-accent)]",
                selected
                  ? "bg-[var(--color-text-accent)] text-[var(--color-text-on-accent)]"
                  : "bg-[var(--color-background-accent)]",
              )}
            >
              Aa
            </span>
            <span className="flex-1 text-left">{option.label}</span>
            {selected ? <IconCheck className="size-3 text-[var(--color-text-accent)]" /> : null}
          </button>
        );
      })}
    </div>
  );
}
