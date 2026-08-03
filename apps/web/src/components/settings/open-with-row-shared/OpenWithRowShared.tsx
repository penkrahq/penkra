import { IconChevronRight } from "@tabler/icons-react";
import { type ReactNode, useState } from "react";

import { cn } from "~/lib/utils";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { disclosureChevronClassName } from "~/lib/disclosureMotion";

import { AppPickerRowShared } from "../app-picker-row-shared/AppPickerRowShared";

export interface OpenWithOption {
  id: string;
  icon?: ReactNode;
  label: string;
}

export interface OpenWithRowSharedProps {
  className?: string;
  defaultValue?: string;
  description?: string;
  onValueChange?: (value: string) => void;
  options?: OpenWithOption[];
  title?: string;
  value?: string;
}

const defaultOptions = [
  { id: "penkra", label: "Penkra" },
  { id: "finder", label: "Finder" },
];

export function OpenWithRowShared({
  className,
  defaultValue,
  description = "Choose the app used to open this item.",
  onValueChange,
  options = defaultOptions,
  title = "Open with",
  value,
}: OpenWithRowSharedProps) {
  const [internalValue, setInternalValue] = useState(defaultValue ?? value ?? options[0]?.id ?? "");
  const [open, setOpen] = useState(false);
  const selectedValue = value ?? internalValue;
  const selectedLabel =
    options.find((option) => option.id === selectedValue)?.label ?? "Choose app";

  function select(nextValue: string) {
    if (value === undefined) setInternalValue(nextValue);
    onValueChange?.(nextValue);
    setOpen(false);
  }

  return (
    <div className={cn("w-full font-sans", className)} data-pencil-component="MqhKC">
      <button
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-3 border-0 bg-transparent py-2.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)]"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[length:var(--app-font-size-ui-lg,13px)] text-[var(--color-text-foreground)]">
            {title}
          </span>
          <span className="text-[length:var(--app-font-size-ui,12px)] text-[var(--color-text-foreground-tertiary)]">
            {description}
          </span>
        </span>
        <span className="flex items-center gap-1 text-[length:var(--app-font-size-ui,12px)] text-[var(--color-text-foreground-secondary)]">
          {selectedLabel}
          <IconChevronRight className={disclosureChevronClassName(open)} />
        </span>
      </button>
      <DisclosureRegion open={open}>
        <div className="flex flex-col gap-2 pb-2.5 pt-1">
          {options.map((option) => (
            <AppPickerRowShared
              icon={option.icon}
              key={option.id}
              onClick={() => select(option.id)}
              selected={option.id === selectedValue}
            >
              {option.label}
            </AppPickerRowShared>
          ))}
        </div>
      </DisclosureRegion>
    </div>
  );
}
