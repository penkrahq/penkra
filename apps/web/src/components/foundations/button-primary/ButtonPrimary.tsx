import { forwardRef } from "react";

import { Button, type ButtonProps } from "~/components/ui/button";
import { cn } from "~/lib/utils";

export type ButtonPrimaryProps = ButtonProps;

export const ButtonPrimary = forwardRef<HTMLButtonElement, ButtonPrimaryProps>(
  function ButtonPrimary({ className, ...props }, ref) {
    return (
      <Button
        className={cn(
          "!h-[41px] w-full !rounded-[10px] !border-0 !px-4 font-sans !text-sm !font-semibold sm:!h-[41px]",
          "focus-visible:!ring-2 focus-visible:!ring-[var(--color-border-focus)]",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
