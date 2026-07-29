import { forwardRef } from "react";

import { Button, type ButtonProps } from "~/components/ui/button";
import { cn } from "~/lib/utils";

export type ButtonSecondaryProps = ButtonProps;

export const ButtonSecondary = forwardRef<HTMLButtonElement, ButtonSecondaryProps>(
  function ButtonSecondary({ className, ...props }, ref) {
    return (
      <Button
        className={cn(
          "!h-[41px] w-full !rounded-[10px] !border-[var(--color-border)] !bg-transparent !px-4 font-sans !text-[13px] !font-medium !text-[var(--color-text-button-secondary)] sm:!h-[41px]",
          "hover:!bg-[var(--color-background-button-secondary-hover)] hover:!text-[var(--color-text-foreground)] active:!bg-[var(--color-background-button-secondary-active)] active:!text-[var(--color-text-foreground)] aria-pressed:!bg-[var(--color-background-button-secondary-active)] aria-pressed:!text-[var(--color-text-foreground)]",
          "focus-visible:!ring-[var(--color-border-focus)] disabled:!bg-transparent disabled:!text-[var(--color-text-foreground-tertiary)] disabled:!opacity-100",
          className,
        )}
        ref={ref}
        variant="outline"
        {...props}
      />
    );
  },
);
