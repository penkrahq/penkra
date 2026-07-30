import { IconFolder, IconFolderOpen } from "@tabler/icons-react";

import { cn } from "~/lib/utils";

export interface FolderStateIconProps {
  disabled?: boolean;
  open?: boolean;
}

export function FolderStateIcon({ disabled = false, open = false }: FolderStateIconProps) {
  return (
    <span
      aria-hidden="true"
      className="relative inline-flex size-3.5 shrink-0 items-center justify-center"
      data-slot="folder-state-icon"
    >
      <IconFolder
        className={cn(
          "absolute size-3.5",
          open && "hidden",
          !disabled && "group-hover/left-rail-row:hidden",
        )}
        data-folder-state="closed"
      />
      <IconFolderOpen
        className={cn(
          "absolute size-3.5",
          !open && "hidden",
          !disabled && !open && "group-hover/left-rail-row:block",
        )}
        data-folder-state="open"
      />
    </span>
  );
}
