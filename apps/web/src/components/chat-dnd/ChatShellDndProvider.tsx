// FILE: ChatShellDndProvider.tsx
// Purpose: Owns the single drag operation spanning the sidebar and chat panes.

import { Accessibility } from "@dnd-kit/dom";
import { DragDropProvider, DragOverlay, useDragOperation } from "@dnd-kit/react";
import type { ReactNode } from "react";

import { readSidebarDndData, SidebarDragPreview } from "../sidebar/SidebarDnd";
import {
  readFolderThreadDndData,
  FolderTabsDragPreview,
} from "../middle-panel/folder-tabs/FolderTabsDnd";
import { ReliablePointerSensor } from "./ReliablePointerSensor";

function ShellDragOverlay() {
  const { source } = useDragOperation();
  const data = readSidebarDndData(source?.data);
  const preview = data?.type === "space" || data?.type === "item" ? data.preview : null;
  const folderData = readFolderThreadDndData(source?.data);

  return (
    <DragOverlay dropAnimation={null}>
      {preview ? (
        <div
          className="pointer-events-none w-56 rounded-md border border-[var(--color-border-focus)] bg-[var(--color-background-elevated-primary-opaque)] shadow-xl"
          data-sidebar-drag-overlay="true"
        >
          <SidebarDragPreview preview={preview} />
        </div>
      ) : folderData ? (
        <div
          className="pointer-events-none rounded-lg border border-[var(--color-border-focus)] bg-[var(--color-background-elevated-primary-opaque)] shadow-xl"
          data-folder-tabs-drag-overlay="true"
        >
          <FolderTabsDragPreview preview={folderData.preview} />
        </div>
      ) : null}
    </DragOverlay>
  );
}

export function ChatShellDndProvider(props: { children: ReactNode }) {
  return (
    <DragDropProvider
      sensors={[ReliablePointerSensor]}
      plugins={(defaults) => defaults.filter((plugin) => plugin !== Accessibility)}
    >
      {props.children}
      <ShellDragOverlay />
    </DragDropProvider>
  );
}
