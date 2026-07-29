import { IconReceipt } from "@tabler/icons-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

import { PermissionRowShared } from "../permission-row-shared/PermissionRowShared";

export interface PermissionSheetInstallProps {
  appName?: string;
  className?: string;
  icon?: ReactNode;
  onInstall?: () => void;
}

export function PermissionSheetInstall({
  appName = "Ledger",
  className,
  icon = <IconReceipt />,
  onInstall,
}: PermissionSheetInstallProps) {
  return (
    <section
      aria-label={`${appName} installation permissions`}
      className={cn(
        "flex w-[440px] flex-col gap-4 rounded-[14px] border border-[var(--color-border)] bg-[var(--color-background-surface)] p-6 font-sans",
        className,
      )}
      data-pencil-component="r5wcGn"
    >
      <header className="flex items-center gap-2.5">
        <span className="inline-flex size-8 items-center justify-center rounded-[7px] bg-[var(--color-background-button-primary)] text-[var(--color-text-button-primary)] [&_svg]:size-[18px]">
          {icon}
        </span>
        <h2 className="text-[15px] font-semibold text-[var(--color-text-foreground)]">
          {appName} wants to:
        </h2>
      </header>
      <section className="flex flex-col gap-0.5">
        <h3 className="text-[11px] font-semibold text-[var(--color-text-foreground-tertiary)]">
          Required — {appName} can't work without these
        </h3>
        <PermissionRowShared required />
      </section>
      <section className="flex flex-col gap-0.5">
        <h3 className="text-[11px] font-semibold text-[var(--color-text-foreground-tertiary)]">
          Optional — you can turn these off
        </h3>
        <PermissionRowShared
          reason='"Attach the conversation when you file an expense."'
          title="Read the conversation you're in"
        />
      </section>
      <button
        className="h-9 cursor-pointer rounded-lg border-0 bg-[var(--color-background-button-primary)] text-[13px] font-semibold text-[var(--color-text-button-primary)] outline-none hover:opacity-90 focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)]"
        onClick={onInstall}
        type="button"
      >
        Install
      </button>
    </section>
  );
}
