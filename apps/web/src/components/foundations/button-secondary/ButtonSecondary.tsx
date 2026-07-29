import { forwardRef } from "react";

import { Button, type ButtonProps } from "~/components/ui/button";
import { cn } from "~/lib/utils";

export type ButtonSecondaryProps = ButtonProps;

export const ButtonSecondary = forwardRef<HTMLButtonElement, ButtonSecondaryProps>(
  function ButtonSecondary({ className, ...props }, ref) {
    return (
      <Button
        className={cn(
          "!h-[41px] w-full !rounded-[10px] !border-[var(--pencil-border)] !bg-transparent !px-4 font-sans !text-[13px] !font-medium !text-[var(--pencil-text-secondary)] sm:!h-[41px]",
          "hover:!bg-white/5 hover:!text-[var(--pencil-text-primary)] active:!bg-[var(--pencil-disabled)] active:!text-[var(--pencil-text-primary)] aria-pressed:!bg-[var(--pencil-disabled)] aria-pressed:!text-[var(--pencil-text-primary)]",
          "disabled:!bg-transparent disabled:!text-[var(--pencil-border-hover)] disabled:!opacity-100",
          className,
        )}
        ref={ref}
        variant="outline"
        {...props}
      />
    );
  },
);
