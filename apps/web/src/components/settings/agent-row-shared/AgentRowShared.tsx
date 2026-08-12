import type { ProviderKind } from "@penkra/contracts";
import type { ReactNode } from "react";

import { ProviderIcon } from "~/components/ProviderIcon";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";

export interface AgentRowSharedProps {
  detail?: string;
  label?: string;
  onClick?: () => void;
  open?: boolean;
  provider?: ProviderKind;
  action?: ReactNode;
}

export function AgentRowShared({
  detail = "Connected",
  label = "Claude",
  onClick,
  open = false,
  provider = "claudeAgent",
  action,
}: AgentRowSharedProps) {
  return (
    <div className="flex min-h-7 w-full items-center gap-2.5 font-sans">
      <button
        aria-expanded={open}
        aria-label={`${label} agent`}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-md border-0 bg-transparent p-0 text-left outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)]"
        onClick={onClick}
        type="button"
      >
        <DisclosureChevron
          className="size-[15px] shrink-0 text-[var(--color-text-foreground-tertiary)]"
          open={open}
        />
        <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-[var(--color-background-button-secondary)]">
          <ProviderIcon className="size-4" provider={provider} />
        </span>
        <span className="truncate text-[length:var(--app-font-size-ui-lg,14px)] font-semibold text-[var(--color-text-foreground)]">
          {label}
        </span>
        {!open && detail ? (
          <span className="ml-auto shrink-0 text-[length:var(--app-font-size-ui,12px)] text-[var(--color-text-foreground-tertiary)]">
            {detail}
          </span>
        ) : null}
      </button>
      {action}
    </div>
  );
}
