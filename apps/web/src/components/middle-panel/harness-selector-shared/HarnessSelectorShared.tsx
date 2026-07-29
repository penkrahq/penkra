import type { ProviderKind } from "@synara/contracts";
import { IconChevronDown } from "@tabler/icons-react";
import { forwardRef, type ButtonHTMLAttributes } from "react";

import { ProviderIcon } from "~/components/ProviderIcon";
import { cn } from "~/lib/utils";

export interface HarnessSelectorSharedProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label?: string;
  provider?: ProviderKind;
  variantLabel?: string;
}

export const HarnessSelectorShared = forwardRef<HTMLButtonElement, HarnessSelectorSharedProps>(
  function HarnessSelectorShared(
    {
      className,
      label = "Claude Sonnet 5",
      provider = "claudeAgent",
      type = "button",
      variantLabel,
      ...props
    },
    ref,
  ) {
    return (
      <button
        className={cn(
          "inline-flex h-[25px] cursor-pointer items-center gap-1 rounded-lg border-0 bg-transparent px-2 font-sans text-xs text-[var(--color-text-foreground-secondary)] outline-none transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)] focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)]",
          className,
        )}
        ref={ref}
        type={type}
        {...props}
      >
        <ProviderIcon className="size-[13px]" provider={provider} />
        <span>{label}</span>
        {variantLabel ? (
          <span className="text-[var(--color-text-foreground-tertiary)]">{variantLabel}</span>
        ) : null}
        <IconChevronDown className="size-3" />
      </button>
    );
  },
);
