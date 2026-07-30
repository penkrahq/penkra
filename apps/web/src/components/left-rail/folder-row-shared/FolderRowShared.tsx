import { IconPlus } from "@tabler/icons-react";
import type { ComponentProps } from "react";

import { FolderStateIcon } from "../folder-state-icon/FolderStateIcon";
import { LeftRailRow } from "../row-shared/LeftRailRow";

export interface FolderRowSharedProps extends Omit<
  ComponentProps<typeof LeftRailRow>,
  "leading" | "trailing"
> {
  expanded?: boolean;
  onAdd?: () => void;
}

export function FolderRowShared({
  children = "penut",
  disabled,
  expanded = false,
  onAdd,
  state,
  ...props
}: FolderRowSharedProps) {
  const showOpenFolder = expanded || state === "open" || state === "selected";

  return (
    <div className="group/folder-row relative w-full">
      <LeftRailRow
        className="gap-1.5 pr-7"
        leading={
          <FolderStateIcon
            {...(disabled === undefined ? {} : { disabled })}
            open={showOpenFolder}
          />
        }
        leadingClassName="size-3.5"
        {...(disabled === undefined ? {} : { disabled })}
        {...(state === undefined ? {} : { state })}
        {...props}
      >
        {children}
      </LeftRailRow>
      {onAdd ? (
        <button
          aria-label="Add thread"
          className="absolute top-1/2 right-2 inline-flex size-3.5 -translate-y-1/2 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-[var(--color-text-foreground-secondary)] opacity-0 outline-none group-hover/folder-row:opacity-100 hover:text-[var(--color-text-foreground)] focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)]"
          onClick={onAdd}
          type="button"
        >
          <IconPlus className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}
