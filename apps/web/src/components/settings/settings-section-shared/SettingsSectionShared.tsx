import type { ReactNode } from "react";

export interface SettingsSectionSharedProps {
  children: ReactNode;
  title?: string;
}

export function SettingsSectionShared({
  children,
  title = "Notifications",
}: SettingsSectionSharedProps) {
  return (
    <section className="w-[440px] font-sans" data-pencil-component="jDh8n">
      <h2 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-foreground-tertiary)]">
        {title}
      </h2>
      <div className="mt-2 divide-y divide-[var(--color-border)] px-5">{children}</div>
    </section>
  );
}
