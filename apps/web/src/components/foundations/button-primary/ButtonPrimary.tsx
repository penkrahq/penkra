import { forwardRef, type ReactNode } from "react";

import { Button, type ButtonProps } from "~/components/ui/button";
import { LoaderCircleIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

export type ButtonPrimaryProps = ButtonProps & {
  loading?: boolean;
  loadingLabel?: ReactNode;
};

export const ButtonPrimary = forwardRef<HTMLButtonElement, ButtonPrimaryProps>(
  function ButtonPrimary(
    { children, className, disabled, loading = false, loadingLabel, ...props },
    ref,
  ) {
    return (
      <Button
        aria-busy={loading || undefined}
        className={cn(
          "!h-[41px] w-full !rounded-[10px] !px-4 font-sans !text-sm !font-semibold sm:!h-[41px]",
          "focus-visible:!ring-2 focus-visible:!ring-[var(--color-border-focus)] disabled:!border disabled:!border-[var(--color-border)] disabled:!bg-[var(--color-background-button-secondary-active)] disabled:!text-[var(--color-text-foreground-tertiary)] disabled:!opacity-100",
          loading
            ? "!border !border-[var(--color-border-heavy)] !bg-[var(--color-background-button-secondary-active)] !text-[var(--color-text-foreground-secondary)] disabled:!border-[var(--color-border-heavy)] disabled:!bg-[var(--color-background-button-secondary-active)] disabled:!text-[var(--color-text-foreground-secondary)]"
            : "!border-0",
          className,
        )}
        disabled={disabled || loading}
        ref={ref}
        {...props}
      >
        {loading ? (
          <LoaderCircleIcon
            aria-hidden="true"
            className="size-4 animate-spin"
          />
        ) : null}
        {loading && loadingLabel ? loadingLabel : children}
      </Button>
    );
  },
);
