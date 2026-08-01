import type { ComponentProps, MouseEvent } from "react";

import { NewThreadIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { FolderStateIcon } from "../folder-state-icon/FolderStateIcon";
import { PinBadgeShared } from "../pin-badge-shared/PinBadgeShared";
import { LeftRailRow } from "../row-shared/LeftRailRow";
import { WorkStatusShared, type WorkStatus } from "../work-status-shared/WorkStatusShared";

export interface FolderRowSharedProps extends Omit<
  ComponentProps<typeof LeftRailRow>,
  "leading" | "trailing"
> {
  expanded?: boolean;
  pinned?: boolean;
  actionLabel?: string;
  onAction?: (event: MouseEvent<HTMLButtonElement>) => void;
  workStatus?: WorkStatus;
}

export function FolderRowShared({
  children = "penut",
  actionLabel,
  disabled,
  expanded = false,
  onAction,
  pinned = false,
  state = "default",
  workStatus = "idle",
  ...props
}: FolderRowSharedProps) {
  const showAction = state === "hover" || state === "focus" || state === "error";
  const showAggregateStatus = !expanded && workStatus !== "idle";

  return (
    <div className="group/folder-row relative w-full">
      <LeftRailRow
        aria-expanded={expanded}
        className={cn(
          "gap-3 pr-2.5 transition-[padding,color,background-color] duration-[140ms] ease-out active:bg-[var(--color-background-button-secondary-hover)] group-hover/folder-row:bg-[var(--color-background-button-secondary-hover)] group-hover/folder-row:text-[var(--color-text-foreground)] group-focus-within/folder-row:bg-[var(--color-background-button-secondary-hover)] group-focus-within/folder-row:text-[var(--color-text-foreground)]",
          onAction && "group-hover/folder-row:pr-9 group-focus-within/folder-row:pr-9",
          showAction && onAction && "pr-9",
          state === "selected" &&
            "bg-[var(--color-background-button-secondary-active)] text-[var(--color-text-foreground)]",
          (state === "focus" || state === "error") &&
            "bg-[var(--color-background-button-secondary-hover)] text-[var(--color-text-foreground)]",
        )}
        leading={
          <span className="relative inline-flex size-3.5 items-center justify-center">
            <FolderStateIcon open={expanded} />
            {pinned ? <PinBadgeShared /> : null}
          </span>
        }
        leadingClassName="size-3.5"
        data-pinned={pinned ? "true" : undefined}
        data-work-status={workStatus}
        {...(disabled === undefined ? {} : { disabled })}
        state={state}
        trailing={showAggregateStatus ? <WorkStatusShared status={workStatus} /> : null}
        {...props}
      >
        <span className="font-medium">{children}</span>
      </LeftRailRow>
      {onAction ? (
        <button
          aria-label={
            actionLabel ??
            `Create thread in ${typeof children === "string" ? children : "this folder"}`
          }
          className={cn(
            "absolute top-1/2 right-2.5 inline-flex size-3.5 -translate-y-1/2 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-[var(--color-text-foreground-secondary)] opacity-0 outline-none transition-[opacity,color] duration-[140ms] ease-out",
            "group-hover/folder-row:opacity-100 hover:text-[var(--color-text-foreground)] focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)]",
            showAction && "opacity-100",
          )}
          onClick={(event) => {
            event.stopPropagation();
            onAction(event);
          }}
          type="button"
        >
          <NewThreadIcon className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}
