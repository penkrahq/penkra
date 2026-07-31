import { FolderIcon, FolderOpenIcon } from "~/lib/icons";

export interface FolderStateIconProps {
  open?: boolean;
}

export function FolderStateIcon({ open = false }: FolderStateIconProps) {
  return (
    <span
      aria-hidden="true"
      className="relative inline-flex size-3.5 shrink-0 items-center justify-center"
      data-slot="folder-state-icon"
    >
      <FolderIcon
        className={open ? "hidden size-3.5" : "size-3.5"}
        data-folder-state="closed"
      />
      <FolderOpenIcon
        className={open ? "size-3.5" : "hidden size-3.5"}
        data-folder-state="open"
      />
    </span>
  );
}
