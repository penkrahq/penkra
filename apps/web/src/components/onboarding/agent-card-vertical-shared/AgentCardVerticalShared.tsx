import type { ProviderKind } from "@synara/contracts";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

import { ProviderIcon } from "~/components/ProviderIcon";
import { cn } from "~/lib/utils";

export interface AgentCardVerticalSharedProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  description?: string;
  icon?: ReactNode;
  provider?: ProviderKind;
  selected?: boolean;
}

export const AgentCardVerticalShared = forwardRef<
  HTMLButtonElement,
  AgentCardVerticalSharedProps
>(function AgentCardVerticalShared(
  {
    children = "Claude",
    className,
    description = "Anthropic",
    icon,
    provider = "claudeAgent",
    selected = false,
    ...props
  },
  ref,
) {
  return (
    <button
      aria-pressed={selected}
      className={cn(
        "flex h-[130px] w-[154px] cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border border-[var(--color-border)] bg-transparent font-sans outline-none transition-colors hover:border-[var(--color-border-heavy)] hover:bg-[var(--color-background-button-secondary-hover)] focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] disabled:cursor-not-allowed disabled:opacity-50",
        selected &&
          "border-[var(--color-border-focus)] bg-[var(--color-background-button-secondary)]",
        className,
      )}
      ref={ref}
      type="button"
      {...props}
    >
      {icon ?? <ProviderIcon className="size-10" provider={provider} />}
      <span className="flex flex-col items-center">
        <span className="text-[13px] font-semibold text-[var(--color-text-foreground)]">
          {children}
        </span>
        <span className="text-xs text-[var(--color-text-foreground-tertiary)]">
          {description}
        </span>
      </span>
    </button>
  );
});
