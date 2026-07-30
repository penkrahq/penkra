import { forwardRef, type ReactNode } from "react";

import { Button, type ButtonProps } from "~/components/ui/button";
import { LoaderCircleIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

export type ButtonSecondaryProps = ButtonProps & {
  loading?: boolean;
  loadingLabel?: ReactNode;
};

export const ButtonSecondary = forwardRef<HTMLButtonElement, ButtonSecondaryProps>(
  function ButtonSecondary(
    { children, className, disabled, loading = false, loadingLabel, ...props },
    ref,
  ) {
    return (
      <Button
        aria-busy={loading || undefined}
        className={cn(
          "!h-[41px] w-full !rounded-[10px] !border-[var(--color-border)] !bg-transparent !px-4 font-sans !text-[13px] !font-medium !text-[var(--color-text-button-secondary)] sm:!h-[41px]",
          "hover:!bg-[var(--color-background-button-secondary-hover)] hover:!text-[var(--color-text-foreground)] active:!bg-[var(--color-background-button-secondary-active)] active:!text-[var(--color-text-foreground)] aria-pressed:!bg-[var(--color-background-button-secondary-active)] aria-pressed:!text-[var(--color-text-foreground)]",
          "focus-visible:!ring-[var(--color-border-focus)] disabled:!bg-transparent disabled:!text-[var(--color-text-foreground-tertiary)] disabled:!opacity-100",
          loading &&
            "!border-[var(--color-border-heavy)] !bg-[var(--color-background-button-secondary-active)] !text-[var(--color-text-foreground-tertiary)] disabled:!border-[var(--color-border-heavy)] disabled:!bg-[var(--color-background-button-secondary-active)] disabled:!text-[var(--color-text-foreground-tertiary)]",
          className,
        )}
        disabled={disabled || loading}
        ref={ref}
        variant="outline"
        {...props}
      >
        {loading ? <LoaderCircleIcon aria-hidden="true" className="size-4 animate-spin" /> : null}
        {loading && loadingLabel ? loadingLabel : children}
      </Button>
    );
  },
);
