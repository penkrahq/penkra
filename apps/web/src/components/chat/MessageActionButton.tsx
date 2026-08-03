// FILE: MessageActionButton.tsx
// Purpose: Shared icon button chrome for compact message actions.
// Layer: Web chat presentation component
// Exports: MessageActionButton

import { forwardRef, type ComponentProps, type ReactNode } from "react";
import { cn } from "~/lib/utils";
import { IconButton } from "../ui/icon-button";
import type { TooltipPopup } from "../ui/tooltip";

export const MESSAGE_ACTION_ICON_CLASS_NAME = "size-[13px] opacity-100";

export const MESSAGE_ACTION_BUTTON_CLASS_NAME =
  "size-[26px] shrink-0 rounded-full border-0 bg-transparent p-0 font-system-ui font-normal leading-none text-[length:inherit] text-[var(--color-text-foreground-secondary)] shadow-none transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)] focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)] disabled:cursor-default disabled:opacity-40 [&_svg:not([class*='size-'])]:size-[13px] [&_svg]:opacity-100";

type MessageActionButtonProps = Omit<
  ComponentProps<"button">,
  "aria-label" | "children" | "title"
> & {
  children: ReactNode;
  label: string;
  tooltip: ReactNode;
  tooltipSide?: ComponentProps<typeof TooltipPopup>["side"];
};

export const MessageActionButton = forwardRef<HTMLButtonElement, MessageActionButtonProps>(
  function MessageActionButton(
    { children, className, label, tooltip, tooltipSide: tooltipSideProp, type: typeProp, ...props },
    ref,
  ) {
    const tooltipSide = tooltipSideProp ?? "top";
    const type = typeProp ?? "button";
    return (
      <IconButton
        {...props}
        ref={ref}
        type={type}
        label={label}
        tooltip={tooltip}
        tooltipSide={tooltipSide}
        className={cn(MESSAGE_ACTION_BUTTON_CLASS_NAME, className)}
        size="icon-xs"
        variant="ghost"
      >
        {children}
      </IconButton>
    );
  },
);
