// FILE: ChatShellDndProvider.tsx
// Purpose: Owns the single drag operation spanning the sidebar and chat panes.

import { Accessibility } from "@dnd-kit/dom";
import { DragDropProvider, DragOverlay, PointerSensor, useDragOperation } from "@dnd-kit/react";
import type { ReactNode } from "react";

import { readSidebarDndData, SidebarDragPreview } from "../sidebar/SidebarDnd";

function ShellDragOverlay() {
  const { source } = useDragOperation();
  const data = readSidebarDndData(source?.data);
  const preview = data?.type === "space" || data?.type === "item" ? data.preview : null;

  return (
    <DragOverlay dropAnimation={{ duration: 160, easing: "cubic-bezier(0.2, 0, 0, 1)" }}>
      {preview ? (
        <div
          className="pointer-events-none w-56 rounded-md border border-[var(--color-border-focus)] bg-[var(--color-background-elevated-primary-opaque)] shadow-xl"
          data-sidebar-drag-overlay="true"
        >
          <SidebarDragPreview preview={preview} />
        </div>
      ) : null}
    </DragOverlay>
  );
}

export function ChatShellDndProvider(props: { children: ReactNode }) {
  return (
    <DragDropProvider
      sensors={[PointerSensor]}
      plugins={(defaults) => defaults.filter((plugin) => plugin !== Accessibility)}
    >
      {props.children}
      <ShellDragOverlay />
    </DragDropProvider>
  );
}
