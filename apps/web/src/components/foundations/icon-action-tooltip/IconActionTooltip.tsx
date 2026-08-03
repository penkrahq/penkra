import type { ReactNode } from "react";

import { Tooltip, TooltipPopup, TooltipShortcut, TooltipTrigger } from "~/components/ui/tooltip";
import { PlusIcon } from "~/lib/icons";

export interface IconActionTooltipProps {
  ariaLabel?: string;
  children?: ReactNode;
  defaultOpen?: boolean;
  label?: string;
  onClick?: () => void;
  shortcut?: string;
}

export function IconActionTooltip({
  ariaLabel = "Add",
  children = <PlusIcon />,
  defaultOpen,
  label = "Select model",
  onClick,
  shortcut = "⌃⇧M",
}: IconActionTooltipProps) {
  return (
    <Tooltip defaultOpen={defaultOpen}>
      <span className="contents" data-pencil-component="zwljJ">
        <TooltipTrigger
          aria-label={ariaLabel}
          className="inline-flex size-[26px] cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-[var(--color-text-foreground-secondary)] outline-none transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)] focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)] [&_svg]:size-4"
          onClick={onClick}
        >
          {children}
        </TooltipTrigger>
        <TooltipPopup>
          <span>{label}</span>
          {shortcut ? <TooltipShortcut>{shortcut}</TooltipShortcut> : null}
        </TooltipPopup>
      </span>
    </Tooltip>
  );
}
