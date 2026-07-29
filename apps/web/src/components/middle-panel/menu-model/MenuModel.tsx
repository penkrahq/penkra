import { cn } from "~/lib/utils";

import { ComposerMenuRow } from "../composer-menu-row/ComposerMenuRow";

const models = [
  "Claude Haiku 4.5",
  "Claude Opus 5",
  "Claude Fable 5",
  "Claude Sonnet 5",
] as const;

export type ComposerModelName = (typeof models)[number];

export interface MenuModelProps {
  className?: string;
  onValueChange?: (model: ComposerModelName) => void;
  value?: ComposerModelName;
}

export function MenuModel({
  className,
  onValueChange,
  value = "Claude Sonnet 5",
}: MenuModelProps) {
  return (
    <div
      aria-label="Model"
      className={cn(
        "flex w-[200px] flex-col gap-px rounded-[10px] border border-[var(--color-border)] bg-[var(--color-background-elevated-primary-opaque)] p-1.5",
        className,
      )}
      data-pencil-component="x8Fk3j"
      role="menu"
    >
      {models.map((model) => (
        <ComposerMenuRow
          aria-checked={value === model}
          className={cn(
            value === model &&
              "bg-[var(--color-background-button-secondary-active)] text-[var(--color-text-foreground)]",
          )}
          key={model}
          onClick={() => onValueChange?.(model)}
          role="menuitemradio"
        >
          {model}
        </ComposerMenuRow>
      ))}
    </div>
  );
}
