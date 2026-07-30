import { IconDots, IconFolder } from "@tabler/icons-react";
import type { HTMLAttributes, ReactNode } from "react";

import { ButtonPanel } from "~/components/foundations/button-panel/ButtonPanel";
import { CHAT_SURFACE_HEADER_HEIGHT_CLASS } from "~/components/chat/chatHeaderControls";
import { cn } from "~/lib/utils";

export interface TopBarThreadProps extends HTMLAttributes<HTMLElement> {
  menuTrigger?: ReactNode;
  onMenu?: () => void;
  onPanelToggle?: () => void;
  panelToggleDisabled?: boolean;
  title?: string;
}

export function TopBarThread({
  children,
  className,
  menuTrigger,
  onMenu,
  onPanelToggle,
  panelToggleDisabled = false,
  title = "Audit HIPAA compliance",
  ...props
}: TopBarThreadProps) {
  return (
    <header
      className={cn(
        "flex w-full items-center gap-2 bg-transparent px-3.5 font-sans text-[13px]",
        CHAT_SURFACE_HEADER_HEIGHT_CLASS,
        className,
      )}
      data-pencil-component="Kpx7i"
      {...props}
    >
      {children ?? (
        <>
          <IconFolder className="size-3.5 text-[var(--color-text-foreground-secondary)]" />
          <span className="truncate text-[var(--color-text-foreground)]">{title}</span>
          {menuTrigger ?? (
            <button
              aria-label="Thread menu"
              className="inline-flex size-3.5 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-[var(--color-text-foreground-tertiary)] outline-none hover:text-[var(--color-text-foreground)] focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)]"
              onClick={onMenu}
              type="button"
            >
              <IconDots className="size-3.5" />
            </button>
          )}
          <span className="flex-1" />
          <ButtonPanel disabled={panelToggleDisabled} onClick={onPanelToggle} />
        </>
      )}
    </header>
  );
}
