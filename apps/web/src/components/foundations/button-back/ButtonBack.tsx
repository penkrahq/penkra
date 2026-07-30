import { forwardRef } from "react";

import { Button, type ButtonProps } from "~/components/ui/button";
import { ChevronLeftIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

export type ButtonBackProps = Omit<ButtonProps, "children">;

export const ButtonBack = forwardRef<HTMLButtonElement, ButtonBackProps>(function ButtonBack(
  { "aria-label": ariaLabel = "Back", className, ...props },
  ref,
) {
  return (
    <Button
      aria-label={ariaLabel}
      className={cn(
        "!size-3.5 !rounded-none !border-0 !bg-transparent !p-0 !text-[var(--color-text-foreground-secondary)] sm:!size-3.5",
        "hover:!text-[var(--color-text-foreground)] active:!text-[var(--color-text-foreground)] focus-visible:!ring-[var(--color-border-focus)] disabled:!text-[var(--color-text-foreground-tertiary)] disabled:!opacity-100 [&_svg]:!size-3.5 [&_svg]:!opacity-100",
        className,
      )}
      ref={ref}
      {...props}
    >
      <ChevronLeftIcon />
    </Button>
  );
});
