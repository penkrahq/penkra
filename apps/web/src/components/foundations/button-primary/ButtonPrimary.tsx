import { forwardRef } from "react";

import { Button, type ButtonProps } from "~/components/ui/button";
import { cn } from "~/lib/utils";

export type ButtonPrimaryProps = ButtonProps;

export const ButtonPrimary = forwardRef<HTMLButtonElement, ButtonPrimaryProps>(
  function ButtonPrimary({ className, ...props }, ref) {
    return (
      <Button
        className={cn(
          "!h-[41px] w-full !rounded-[10px] !border-0 !bg-[var(--pencil-accent)] !px-4 font-sans !text-sm !font-semibold !text-[var(--pencil-white)] sm:!h-[41px]",
          "hover:!bg-[var(--pencil-accent-hover)] active:!bg-[var(--pencil-accent-active)] aria-pressed:!bg-[var(--pencil-accent-active)]",
          "focus-visible:!ring-2 focus-visible:!ring-[var(--pencil-accent-focus)] disabled:!bg-[var(--pencil-disabled)] disabled:!text-[var(--pencil-border-hover)] disabled:!opacity-100",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
