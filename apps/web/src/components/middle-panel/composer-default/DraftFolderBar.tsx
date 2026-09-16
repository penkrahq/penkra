import type { ReactNode } from "react";

export function DraftFolderBar({ folderPicker }: { folderPicker: ReactNode }) {
  return (
    <div className="flex h-full min-w-0 items-center overflow-visible px-2">{folderPicker}</div>
  );
}
