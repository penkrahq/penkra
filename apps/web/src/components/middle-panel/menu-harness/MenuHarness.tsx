import type { ProviderKind } from "@penkra/contracts";

import { ProviderIcon } from "~/components/ProviderIcon";
import { cn } from "~/lib/utils";

import { ComposerMenuRow } from "../composer-menu-row/ComposerMenuRow";

const harnesses: Array<{
  disabled?: boolean;
  label: string;
  provider: ProviderKind;
}> = [
  { label: "ChatGPT", provider: "codex" },
  { label: "Claude", provider: "claudeAgent" },
  { label: "OpenCode", provider: "opencode" },
];

export interface MenuHarnessProps {
  className?: string;
  onValueChange?: (provider: ProviderKind) => void;
  value?: ProviderKind;
}

export function MenuHarness({ className, onValueChange, value = "claudeAgent" }: MenuHarnessProps) {
  return (
    <div
      aria-label="Agent harness"
      className={cn(
        "flex w-[220px] flex-col gap-px rounded-[10px] border border-[var(--color-border)] bg-[var(--color-background-elevated-primary-opaque)] p-1.5",
        className,
      )}
      data-pencil-component="FLLg5"
      role="menu"
    >
      {harnesses.map((harness) => (
        <ComposerMenuRow
          aria-checked={value === harness.provider}
          className={cn(
            value === harness.provider &&
              "bg-[var(--color-background-button-secondary-active)] text-[var(--color-text-foreground)]",
          )}
          disabled={harness.disabled}
          key={harness.provider}
          leading={<ProviderIcon className="size-4" provider={harness.provider} />}
          onClick={() => onValueChange?.(harness.provider)}
          role="menuitemradio"
        >
          {harness.label}
        </ComposerMenuRow>
      ))}
    </div>
  );
}
