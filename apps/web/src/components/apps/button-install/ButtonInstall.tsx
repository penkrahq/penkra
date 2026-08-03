import type { ButtonHTMLAttributes } from "react";

import { cn } from "~/lib/utils";

export interface ButtonInstallProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  installed?: boolean;
}

export function ButtonInstall({
  children,
  className,
  installed = false,
  ...props
}: ButtonInstallProps) {
  return (
    <button
      className={cn(
        "inline-flex h-7 cursor-pointer items-center justify-center rounded-md border border-transparent bg-[var(--color-background-button-primary)] px-3 text-[length:var(--app-font-size-ui,12px)] font-semibold text-[var(--color-text-button-primary)] outline-none hover:opacity-90 focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)] disabled:cursor-not-allowed disabled:opacity-50",
        installed &&
          "border-[var(--color-border)] bg-transparent text-[var(--color-text-foreground-secondary)]",
        className,
      )}
      data-pencil-component="GYrNw"
      type="button"
      {...props}
    >
      {children ?? (installed ? "Open" : "Install")}
    </button>
  );
}
