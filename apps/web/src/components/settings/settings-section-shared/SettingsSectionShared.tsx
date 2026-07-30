import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "~/lib/utils";

export interface SettingsSectionSharedProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  children: ReactNode;
  contentClassName?: string;
  title?: ReactNode;
}

export function SettingsSectionShared({
  children,
  className,
  contentClassName,
  title = "Notifications",
  ...props
}: SettingsSectionSharedProps) {
  return (
    <section className={cn("w-full font-sans", className)} data-pencil-component="jDh8n" {...props}>
      <h2 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-foreground-tertiary)]">
        {title}
      </h2>
      <div
        className={cn(
          "mt-2 divide-y divide-[var(--color-border)] rounded-[10px] border border-[var(--color-border)] bg-[var(--color-background-surface)] px-5",
          contentClassName,
        )}
      >
        {children}
      </div>
    </section>
  );
}
