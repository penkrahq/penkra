import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "~/lib/utils";

export interface SettingRowSharedProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
  control?: ReactNode;
  description?: ReactNode;
  label?: ReactNode;
  resetAction?: ReactNode;
  status?: ReactNode;
}

export function SettingRowShared({
  children,
  className,
  control,
  description,
  label = "Allow notifications",
  resetAction,
  status,
  ...props
}: SettingRowSharedProps) {
  return (
    <div
      className={cn("flex min-h-[51px] w-full items-center gap-3 font-sans", className)}
      {...props}
    >
      <span className="flex min-w-0 flex-1 flex-col py-3">
        <span className="flex min-h-5 items-center gap-1.5 text-[length:var(--app-font-size-ui,12px)] text-[var(--color-text-foreground)]">
          {label}
          {resetAction ? (
            <span className="inline-flex size-5 shrink-0 items-center justify-center">
              {resetAction}
            </span>
          ) : null}
        </span>
        {description ? (
          <span className="mt-0.5 text-[length:var(--app-font-size-ui-sm,11px)] leading-relaxed text-[var(--color-text-foreground-tertiary)]">
            {description}
          </span>
        ) : null}
        {status ? (
          <span className="pt-1 text-[length:var(--app-font-size-ui-sm,11px)] text-[var(--color-text-foreground-tertiary)]">
            {status}
          </span>
        ) : null}
      </span>
      {control}
      {children ? <div className="basis-full">{children}</div> : null}
    </div>
  );
}
