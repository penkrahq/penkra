import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "~/lib/utils";

export interface SettingsSectionSharedProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  action?: ReactNode;
  children: ReactNode;
  contentClassName?: string;
  title?: ReactNode;
}

export function SettingsSectionShared({
  action,
  children,
  className,
  contentClassName,
  title = "Notifications",
  ...props
}: SettingsSectionSharedProps) {
  return (
    <section className={cn("w-full font-sans", className)} data-pencil-component="jDh8n" {...props}>
      <div className="flex min-h-4 items-center justify-between gap-3">
        <h2 className="text-[length:var(--app-font-size-ui-sm,11px)] font-semibold uppercase tracking-wide text-[var(--color-text-foreground-tertiary)]">
          {title}
        </h2>
        {action}
      </div>
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
