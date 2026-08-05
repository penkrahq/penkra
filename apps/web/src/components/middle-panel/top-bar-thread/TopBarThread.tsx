import type { ProviderKind } from "@penkra/contracts";
import { IconDots } from "@tabler/icons-react";
import type { HTMLAttributes, ReactNode } from "react";

import { CHAT_SURFACE_HEADER_HEIGHT_CLASS } from "~/components/chat/chatHeaderControls";
import { CentralIcon } from "~/lib/central-icons";
import { cn } from "~/lib/utils";
import { ThreadIdentityShared } from "../thread-identity-shared/ThreadIdentityShared";

export interface TopBarThreadProps extends HTMLAttributes<HTMLElement> {
  harness?: ProviderKind;
  leftRailCollapsed?: boolean;
  menuTrigger?: ReactNode;
  onMenu?: () => void;
  onRestoreLeftRail?: () => void;
  pinned?: boolean;
  title?: string;
}

export function TopBarThread({
  children,
  className,
  harness = "codex",
  leftRailCollapsed = false,
  menuTrigger,
  onMenu,
  onRestoreLeftRail,
  pinned = false,
  title = "Audit HIPAA compliance",
  ...props
}: TopBarThreadProps) {
  return (
    <header
      className={cn(
        "flex w-full items-center bg-transparent px-3.5 font-sans text-[length:var(--app-font-size-chat,13px)]",
        CHAT_SURFACE_HEADER_HEIGHT_CLASS,
        className,
      )}
      data-pencil-component="Kpx7i"
      data-pencil-state={leftRailCollapsed ? "left-rail-collapsed" : "left-rail-expanded"}
      {...props}
    >
      {children ?? (
        <>
          {leftRailCollapsed ? (
            <button
              aria-label="Restore left rail"
              className="inline-flex size-4 shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-[var(--color-text-foreground-secondary)] outline-none hover:text-[var(--color-text-foreground)] focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)] [-webkit-app-region:no-drag]"
              data-slot="left-rail-restore"
              onClick={onRestoreLeftRail}
              type="button"
            >
              <CentralIcon className="size-4" name="sidebar-simple-left-wide" />
            </button>
          ) : (
            <ThreadIdentityShared harness={harness} pinned={pinned} />
          )}
          <span
            className={cn(
              "truncate text-[var(--color-text-foreground)]",
              leftRailCollapsed ? "ml-1.5" : "ml-2",
            )}
          >
            {title}
          </span>
          <span className="ml-2 inline-flex shrink-0">
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
          </span>
          <span className="ml-2 flex-1" />
        </>
      )}
    </header>
  );
}
