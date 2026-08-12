import type { ProviderKind } from "@penkra/contracts";
import { IconKey } from "@tabler/icons-react";

import { ProviderIcon } from "~/components/ProviderIcon";
import { cn } from "~/lib/utils";

export function ConnectionAuthActionShared({
  ariaLabel,
  disabled = false,
  kind,
  label,
  onClick,
  provider,
}: {
  readonly ariaLabel?: string;
  readonly disabled?: boolean;
  readonly kind: "key" | "sign-in";
  readonly label: string;
  readonly onClick: () => void;
  readonly provider: ProviderKind;
}) {
  return (
    <button
      aria-label={ariaLabel}
      className={cn(
        "inline-flex h-8 items-center gap-[7px] rounded-lg px-3 text-[12px] font-medium transition-colors disabled:opacity-40",
        kind === "sign-in"
          ? "bg-[var(--color-text-foreground)] font-semibold text-[var(--color-background)]"
          : "border border-[var(--color-border)] bg-[var(--color-background-surface)] text-[var(--color-text-foreground)] hover:bg-[var(--color-background-button-secondary)]",
      )}
      data-pencil-component="YgnIY"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {kind === "sign-in" ? (
        <ProviderIcon className="size-4" provider={provider} />
      ) : (
        <IconKey className="size-4 text-[var(--color-text-foreground-secondary)]" />
      )}
      {label}
    </button>
  );
}
