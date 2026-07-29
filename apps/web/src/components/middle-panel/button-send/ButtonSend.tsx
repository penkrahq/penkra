import { IconArrowUp } from "@tabler/icons-react";
import { forwardRef, type ButtonHTMLAttributes } from "react";

import { cn } from "~/lib/utils";

export type ButtonSendProps = ButtonHTMLAttributes<HTMLButtonElement>;

export const ButtonSend = forwardRef<HTMLButtonElement, ButtonSendProps>(function ButtonSend(
  { "aria-label": ariaLabel = "Send", className, type = "submit", ...props },
  ref,
) {
  return (
    <button
      aria-label={ariaLabel}
      className={cn(
        "inline-flex size-[26px] shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-[var(--color-background-button-primary)] p-0 text-[var(--color-text-button-primary)] outline-none transition-[background-color,opacity] hover:bg-[color-mix(in_srgb,var(--color-background-button-primary)_90%,transparent)] focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)] disabled:cursor-not-allowed disabled:opacity-64",
        className,
      )}
      ref={ref}
      type={type}
      {...props}
    >
      <IconArrowUp className="size-3.5" />
    </button>
  );
});
