import { IconFolder, IconPlus } from "@tabler/icons-react";
import type { ComponentProps } from "react";

import { LeftRailRow } from "../row-shared/LeftRailRow";

export interface FolderRowSharedProps
  extends Omit<ComponentProps<typeof LeftRailRow>, "leading" | "trailing"> {
  onAdd?: () => void;
}

export function FolderRowShared({
  children = "penut",
  onAdd,
  ...props
}: FolderRowSharedProps) {
  return (
    <div className="group/folder-row relative w-full">
      <LeftRailRow className="pr-7" leading={<IconFolder />} {...props}>
        {children}
      </LeftRailRow>
      {onAdd ? (
        <button
          aria-label="Add thread"
          className="absolute top-1/2 right-2 inline-flex size-3.5 -translate-y-1/2 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-[var(--pencil-text-secondary)] opacity-0 outline-none group-hover/folder-row:opacity-100 hover:text-[var(--pencil-text-primary)] focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-[var(--pencil-accent-focus)]"
          onClick={onAdd}
          type="button"
        >
          <IconPlus className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}
