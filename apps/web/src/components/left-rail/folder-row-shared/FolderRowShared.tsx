import type { ComponentProps, MouseEvent } from "react";

import { EllipsisIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { FolderStateIcon } from "../folder-state-icon/FolderStateIcon";
import { LeftRailRow } from "../row-shared/LeftRailRow";

export interface FolderRowSharedProps extends Omit<
  ComponentProps<typeof LeftRailRow>,
  "leading" | "trailing"
> {
  expanded?: boolean;
  onAction?: (event: MouseEvent<HTMLButtonElement>) => void;
}

export function FolderRowShared({
  children = "penut",
  disabled,
  expanded = false,
  onAction,
  state = "default",
  ...props
}: FolderRowSharedProps) {
  const showAction =
    state === "hover" ||
    state === "active" ||
    state === "selected" ||
    state === "focus" ||
    state === "error";

  return (
    <div className="group/folder-row relative w-full">
      <LeftRailRow
        aria-expanded={expanded}
        className={cn(
          "gap-3 pr-2.5 active:bg-[var(--color-background-button-secondary-hover)]",
          state === "selected" &&
            "bg-[var(--color-background-button-secondary-active)] text-[var(--color-text-foreground)]",
          (state === "focus" || state === "error") &&
            "bg-[var(--color-background-button-secondary-hover)] text-[var(--color-text-foreground)]",
        )}
        leading={<FolderStateIcon open={expanded} />}
        leadingClassName="size-3.5"
        {...(disabled === undefined ? {} : { disabled })}
        state={state}
        {...props}
      >
        <span className="font-medium">{children}</span>
      </LeftRailRow>
      {onAction ? (
        <button
          aria-label="Folder actions"
          className={cn(
            "absolute top-1/2 right-2.5 inline-flex size-3.5 -translate-y-1/2 cursor-pointer items-center justify-center border-0 bg-[var(--color-background-button-secondary-hover)] p-0 text-[var(--color-text-foreground-secondary)] opacity-0 outline-none",
            "group-hover/folder-row:opacity-100 hover:text-[var(--color-text-foreground)] focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)]",
            showAction && "opacity-100",
          )}
          onClick={(event) => {
            event.stopPropagation();
            onAction(event);
          }}
          type="button"
        >
          <EllipsisIcon className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}
