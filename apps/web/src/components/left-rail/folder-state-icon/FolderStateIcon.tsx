import { FolderIcon, FolderOpenIcon } from "~/lib/icons";

export interface FolderStateIconProps {
  iconDataUrl?: string | null;
  open?: boolean;
}

export function FolderStateIcon({ iconDataUrl, open = false }: FolderStateIconProps) {
  return (
    <span
      aria-hidden="true"
      className="relative inline-flex size-3.5 shrink-0 items-center justify-center"
      data-slot="folder-state-icon"
    >
      {iconDataUrl ? (
        <img alt="" className="size-3.5 rounded-[3px] object-cover" src={iconDataUrl} />
      ) : (
        <>
          <FolderIcon
            className={open ? "hidden size-3.5" : "size-3.5"}
            data-folder-state="closed"
          />
          <FolderOpenIcon
            className={open ? "size-3.5" : "hidden size-3.5"}
            data-folder-state="open"
          />
        </>
      )}
    </span>
  );
}
