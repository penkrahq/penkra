import type { ReactNode } from "react";

import {
  Tooltip,
  TooltipPopup,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/ui/tooltip";
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
    <TooltipProvider>
      <Tooltip defaultOpen={defaultOpen}>
        <TooltipTrigger
          aria-label={ariaLabel}
          className="inline-flex size-[26px] cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-[var(--pencil-text-secondary)] outline-none transition-colors hover:bg-white/5 hover:text-[var(--pencil-text-primary)] focus-visible:ring-1 focus-visible:ring-[var(--pencil-accent-focus)] [&_svg]:size-4"
          onClick={onClick}
        >
          {children}
        </TooltipTrigger>
        <TooltipPopup
          className="!rounded-lg !border !border-[#1a1a1a] !bg-[var(--pencil-overlay)] !text-[var(--pencil-text-primary)] after:absolute after:-bottom-1 after:left-1/2 after:size-2 after:-translate-x-1/2 after:rotate-45 after:bg-[var(--pencil-overlay)]"
          sideOffset={8}
          viewportClassName="flex items-center gap-2 !px-2.5 !py-1.5"
        >
          <span className="font-sans text-xs leading-[15px]">{label}</span>
          {shortcut ? (
            <kbd className="rounded-full bg-white/5 px-1 py-0.5 font-sans text-[11px] leading-[13px] font-normal text-[var(--pencil-text-tertiary)]">
              {shortcut}
            </kbd>
          ) : null}
        </TooltipPopup>
      </Tooltip>
    </TooltipProvider>
  );
}
