import { IconWallet } from "@tabler/icons-react";

import { PermissionSection } from "../permission-section/PermissionSection";

export interface PermissionSheetProps {
  appName?: string;
}

export function PermissionSheet({ appName = "Ledger" }: PermissionSheetProps) {
  return (
    <section
      aria-labelledby="permission-sheet-title"
      className="w-[440px] rounded-[14px] border border-[var(--color-border)] bg-[var(--color-background-elevated-primary-opaque)] p-6 font-sans"
      data-pencil-component="p3iWcp"
    >
      <header className="flex h-8 items-center gap-2.5">
        <span className="inline-flex size-8 items-center justify-center rounded-[7px] bg-blue-500 text-white">
          <IconWallet className="size-4" />
        </span>
        <h2
          className="text-[15px] font-semibold text-[var(--color-text-foreground)]"
          id="permission-sheet-title"
        >
          {appName} wants to:
        </h2>
      </header>
      <div className="mt-4">
        <PermissionSection />
      </div>
    </section>
  );
}
