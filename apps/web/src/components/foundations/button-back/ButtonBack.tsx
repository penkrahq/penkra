import { forwardRef } from "react";

import { Button, type ButtonProps } from "~/components/ui/button";
import { ChevronLeftIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

export type ButtonBackProps = Omit<ButtonProps, "children">;

export const ButtonBack = forwardRef<HTMLButtonElement, ButtonBackProps>(
  function ButtonBack({ "aria-label": ariaLabel = "Back", className, ...props }, ref) {
    return (
      <Button
        aria-label={ariaLabel}
        className={cn(
          "!size-3.5 !rounded-none !border-0 !bg-transparent !p-0 !text-[var(--pencil-text-secondary)] sm:!size-3.5",
          "hover:!text-[var(--pencil-text-primary)] active:!text-[var(--pencil-text-primary)] disabled:!text-[var(--pencil-border-hover)] disabled:!opacity-100 [&_svg]:!size-3.5 [&_svg]:!opacity-100",
          className,
        )}
        ref={ref}
        {...props}
      >
        <ChevronLeftIcon />
      </Button>
    );
  },
);
