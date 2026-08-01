import type { ProviderKind } from "@penkra/contracts";
import { IconChevronRight } from "@tabler/icons-react";

import { ProviderIcon } from "~/components/ProviderIcon";

export interface AgentRowSharedProps {
  detail?: string;
  label?: string;
  onClick?: () => void;
  provider?: ProviderKind;
}

export function AgentRowShared({
  detail = "Connected",
  label = "Claude",
  onClick,
  provider = "claudeAgent",
}: AgentRowSharedProps) {
  return (
    <button
      className="flex h-[63px] w-full cursor-pointer items-center gap-3 rounded-md border-0 bg-transparent px-2.5 font-sans outline-none hover:bg-[var(--color-background-button-secondary-hover)] focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)]"
      onClick={onClick}
      type="button"
    >
      <span className="inline-flex size-8 items-center justify-center rounded-lg bg-[var(--color-background-button-secondary)]">
        <ProviderIcon className="size-5" provider={provider} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col text-left">
        <span className="text-[13px] text-[var(--color-text-foreground)]">{label}</span>
        <span className="text-xs text-[var(--color-text-foreground-tertiary)]">{detail}</span>
      </span>
      <IconChevronRight className="size-4 text-[var(--color-text-foreground-tertiary)]" />
    </button>
  );
}
