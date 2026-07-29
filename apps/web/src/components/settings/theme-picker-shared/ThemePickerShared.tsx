import { IconChevronDown } from "@tabler/icons-react";
import { useState } from "react";

import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from "~/components/ui/popover";
import { cn } from "~/lib/utils";

import {
  MenuThemePicker,
  type ThemePresetName,
} from "../menu-theme-picker/MenuThemePicker";

export interface ThemePickerSharedProps {
  className?: string;
  disabled?: boolean;
  onValueChange?: (value: ThemePresetName) => void;
  value?: ThemePresetName;
}

export function ThemePickerShared({
  className,
  disabled = false,
  onValueChange,
  value,
}: ThemePickerSharedProps) {
  const [internalValue, setInternalValue] = useState<ThemePresetName>(value ?? "GitHub");
  const selectedValue = value ?? internalValue;

  function select(nextValue: ThemePresetName) {
    if (value === undefined) setInternalValue(nextValue);
    onValueChange?.(nextValue);
  }

  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          "flex h-7 w-[102px] cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-background-control-opaque)] px-2.5 text-xs text-[var(--color-text-foreground)] outline-none hover:bg-[var(--color-background-button-secondary-hover)] focus-visible:border-[var(--color-border-focus)] disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        data-pencil-component="H7QYVP"
        disabled={disabled}
      >
        <span className="inline-flex size-[18px] items-center justify-center rounded bg-[var(--color-background-accent)] text-[9px] font-bold text-[var(--color-text-accent)]">
          Aa
        </span>
        <span className="min-w-0 flex-1 truncate text-left">{selectedValue}</span>
        <IconChevronDown className="size-3 shrink-0 text-[var(--color-text-foreground-tertiary)]" />
      </PopoverTrigger>
      <PopoverPopup
        align="end"
        className="border-0 bg-transparent p-0 shadow-none"
        sideOffset={6}
      >
        <MenuThemePicker onValueChange={select} value={selectedValue} />
      </PopoverPopup>
    </Popover>
  );
}
