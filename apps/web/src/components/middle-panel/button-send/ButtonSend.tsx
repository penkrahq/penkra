import { IconArrowUp, IconLoader2, IconSquareFilled } from "@tabler/icons-react";
import { forwardRef, type ButtonHTMLAttributes } from "react";

import { cn } from "~/lib/utils";

export type ButtonSendState = "ready" | "hover" | "disabled" | "sending" | "stop";

export interface ButtonSendProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  visualState?: ButtonSendState;
}

export const ButtonSend = forwardRef<HTMLButtonElement, ButtonSendProps>(function ButtonSend(
  {
    "aria-label": ariaLabel,
    className,
    disabled = false,
    type = "submit",
    visualState: visualStateProp,
    ...props
  },
  ref,
) {
  const visualState = visualStateProp ?? (disabled ? "disabled" : "ready");
  const isUnavailable = disabled || visualState === "disabled" || visualState === "sending";
  const resolvedAriaLabel =
    ariaLabel ??
    (visualState === "stop"
      ? "Stop generation"
      : visualState === "sending"
        ? "Sending"
        : "Send message");

  return (
    <button
      aria-label={resolvedAriaLabel}
      className={cn(
        "inline-flex size-[26px] shrink-0 items-center justify-center rounded-full border-0 p-0 outline-none transition-[background-color,color,opacity] focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)] disabled:cursor-not-allowed disabled:opacity-100",
        visualState === "ready" || visualState === "stop"
          ? "cursor-pointer bg-[var(--color-background-button-primary)] text-[var(--color-text-button-primary)] hover:bg-[color-mix(in_srgb,var(--color-background-button-primary)_90%,transparent)]"
          : null,
        visualState === "hover"
          ? "cursor-pointer bg-[color-mix(in_srgb,var(--color-background-button-primary)_90%,transparent)] text-[var(--color-text-button-primary)]"
          : null,
        visualState === "disabled" || visualState === "sending"
          ? "bg-[color-mix(in_srgb,var(--color-text-foreground)_12%,transparent)] text-[var(--color-text-foreground-tertiary)]"
          : null,
        className,
      )}
      data-pencil-component="eFqUm"
      data-send-state={visualState}
      disabled={isUnavailable}
      ref={ref}
      type={type}
      {...props}
    >
      {visualState === "sending" ? (
        <IconLoader2 aria-hidden="true" className="size-3.5 animate-spin" />
      ) : visualState === "stop" ? (
        <IconSquareFilled aria-hidden="true" className="size-2" />
      ) : (
        <IconArrowUp aria-hidden="true" className="size-3.5" />
      )}
    </button>
  );
});
