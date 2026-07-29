import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "~/lib/utils";

export interface SettingRowSharedProps extends HTMLAttributes<HTMLDivElement> {
  control?: ReactNode;
  description?: string;
  label?: string;
}

export function SettingRowShared({
  className,
  control,
  description,
  label = "Allow notifications",
  ...props
}: SettingRowSharedProps) {
  return (
    <div
      className={cn("flex min-h-[51px] w-full items-center gap-3 font-sans", className)}
      {...props}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[13px] text-[var(--color-text-foreground)]">{label}</span>
        {description ? (
          <span className="mt-0.5 text-xs text-[var(--color-text-foreground-tertiary)]">
            {description}
          </span>
        ) : null}
      </span>
      {control}
    </div>
  );
}
