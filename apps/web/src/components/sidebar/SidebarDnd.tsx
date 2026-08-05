// FILE: SidebarDnd.tsx
// Purpose: Registers sidebar rows with the shell-wide current dnd-kit provider.

import { useDragDropMonitor, useDroppable } from "@dnd-kit/react";
import { useSortable } from "@dnd-kit/react/sortable";
import type { DragEndEvent } from "@dnd-kit/react";
import type { ProviderKind, SidebarItemParent, SidebarItemReference } from "@penkra/contracts";
import { ContainerId, SpaceId } from "@penkra/contracts";
import { type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { FolderRowShared } from "../left-rail/folder-row-shared/FolderRowShared";
import { SpaceHeaderShared } from "../left-rail/space-header-shared/SpaceHeaderShared";
import {
  ThreadRowShared,
  type ThreadRowLevel,
} from "../left-rail/thread-row-shared/ThreadRowShared";
import type { WorkStatus } from "../left-rail/work-status-shared/WorkStatusShared";

export const SIDEBAR_SPACE_DRAG_TYPE = "penkra/sidebar-space";
export const SIDEBAR_PROJECT_DRAG_TYPE = "penkra/sidebar-project";
export const SIDEBAR_THREAD_DRAG_TYPE = "penkra/sidebar-thread";

function sidebarItemDragType(kind: "project" | "thread", pinned: boolean): string {
  const base = kind === "project" ? SIDEBAR_PROJECT_DRAG_TYPE : SIDEBAR_THREAD_DRAG_TYPE;
  return `${base}:${pinned ? "pinned" : "unpinned"}`;
}

export const SIDEBAR_PROJECT_DRAG_TYPES = [
  sidebarItemDragType("project", true),
  sidebarItemDragType("project", false),
];
export const SIDEBAR_THREAD_DRAG_TYPES = [
  sidebarItemDragType("thread", true),
  sidebarItemDragType("thread", false),
];

export type SidebarDndPreview =
  | {
      kind: "space";
      label: string;
      expanded: boolean;
    }
  | {
      kind: "project";
      label: string;
      expanded: boolean;
      pinned: boolean;
      workStatus: WorkStatus;
    }
  | {
      kind: "thread";
      label: string;
      harness: ProviderKind | "github";
      level: ThreadRowLevel;
      pinned: boolean;
      workStatus: WorkStatus;
    };

export type SidebarDndData =
  | {
      type: "space";
      spaceId: SpaceId;
      label: string;
      preview: Extract<SidebarDndPreview, { kind: "space" }>;
    }
  | {
      type: "item";
      item: SidebarItemReference;
      parent: SidebarItemParent;
      label: string;
      preview: Exclude<SidebarDndPreview, { kind: "space" }>;
    }
  | {
      type: "container";
      parent: SidebarItemParent;
      label: string;
    };

export function sidebarSpaceDndId(spaceId: SpaceId): string {
  return `sidebar-space:${spaceId}`;
}

export function sidebarItemDndId(item: SidebarItemReference): string {
  return `sidebar-item:${item.kind}:${item.id}`;
}

export function sidebarParentDndGroup(parent: SidebarItemParent): string {
  return parent.kind === "space"
    ? `sidebar-parent:space:${parent.spaceId}`
    : `sidebar-parent:project:${parent.projectId}`;
}

export function sidebarParentFromDndGroup(group: unknown): SidebarItemParent | null {
  if (typeof group !== "string") return null;
  const spacePrefix = "sidebar-parent:space:";
  if (group.startsWith(spacePrefix)) {
    const spaceId = group.slice(spacePrefix.length);
    return spaceId ? { kind: "space", spaceId: SpaceId.makeUnsafe(spaceId) } : null;
  }
  const projectPrefix = "sidebar-parent:project:";
  if (group.startsWith(projectPrefix)) {
    const projectId = group.slice(projectPrefix.length);
    return projectId ? { kind: "project", projectId: ContainerId.makeUnsafe(projectId) } : null;
  }
  return null;
}

export function readSidebarDndData(value: unknown): SidebarDndData | null {
  if (!value || typeof value !== "object" || !("type" in value)) return null;
  const data = value as SidebarDndData;
  return data.type === "space" || data.type === "item" || data.type === "container" ? data : null;
}

export function dragTypeForData(data: SidebarDndData): string {
  if (data.type === "space") return SIDEBAR_SPACE_DRAG_TYPE;
  if (data.type === "item" && data.item.kind === "project") {
    return sidebarItemDragType("project", data.preview.pinned);
  }
  if (data.type === "item") {
    return sidebarItemDragType("thread", data.preview.pinned);
  }
  return SIDEBAR_THREAD_DRAG_TYPE;
}

export function acceptedTypesForData(data: SidebarDndData): string[] {
  if (data.type === "space") return [SIDEBAR_SPACE_DRAG_TYPE];
  if (data.type === "container") {
    return data.parent.kind === "space"
      ? [...SIDEBAR_PROJECT_DRAG_TYPES, ...SIDEBAR_THREAD_DRAG_TYPES]
      : [...SIDEBAR_THREAD_DRAG_TYPES];
  }
  const pinned = data.preview.pinned;
  return data.parent.kind === "space"
    ? [sidebarItemDragType("project", pinned), sidebarItemDragType("thread", pinned)]
    : [sidebarItemDragType("thread", pinned)];
}

export function SidebarDndMonitor(props: {
  children: ReactNode;
  onDragEnd: (event: DragEndEvent) => void;
}) {
  useDragDropMonitor({
    onDragEnd: props.onDragEnd,
  });
  return props.children;
}

export function SidebarDragPreview(props: { preview: SidebarDndPreview }) {
  const { preview } = props;
  if (preview.kind === "space") {
    return (
      <SpaceHeaderShared aria-hidden="true" expanded={preview.expanded} state="hover" tabIndex={-1}>
        {preview.label}
      </SpaceHeaderShared>
    );
  }
  if (preview.kind === "project") {
    return (
      <FolderRowShared
        aria-hidden="true"
        expanded={preview.expanded}
        pinned={preview.pinned}
        tabIndex={-1}
        workStatus={preview.workStatus}
      >
        {preview.label}
      </FolderRowShared>
    );
  }
  return (
    <ThreadRowShared
      aria-hidden="true"
      harness={preview.harness}
      level={preview.level}
      pinned={preview.pinned}
      tabIndex={-1}
      workStatus={preview.workStatus}
    >
      {preview.label}
    </ThreadRowShared>
  );
}

export function SortableSidebarNode(props: {
  children: ReactNode;
  data: SidebarDndData;
  group: string;
  id: string;
  index: number;
}) {
  const sortable = useSortable({
    id: props.id,
    index: props.index,
    group: props.group,
    type: dragTypeForData(props.data),
    accept: acceptedTypesForData(props.data),
    data: props.data,
    transition: { duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" },
  });
  const setNodeRef = (element: Element | null) => {
    sortable.ref(element);
    // Keep the layout wrapper inert. Every sidebar node already owns an accessible
    // row/header button, so registering that existing control as the handle avoids
    // introducing a second tab stop or a nested synthetic button role.
    sortable.handleRef(element?.querySelector("button") ?? element);
  };

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "relative",
        sortable.isDragging && "z-20 opacity-35",
        sortable.isDropTarget && "z-10",
      )}
      data-sidebar-dnd-source={sortable.isDragSource ? "true" : undefined}
      data-sidebar-dnd-target={sortable.isDropTarget ? "true" : undefined}
    >
      {sortable.isDropTarget ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute right-2 left-2 top-0 z-30 h-0.5 rounded-full bg-[var(--color-border-focus)]"
          data-sidebar-drop-indicator="before"
        />
      ) : null}
      {props.children}
    </div>
  );
}

export function SidebarContainerDropTarget(props: {
  children?: ReactNode;
  data: Extract<SidebarDndData, { type: "container" }>;
  id: string;
  className?: string;
}) {
  const droppable = useDroppable({
    id: props.id,
    type: `penkra/sidebar-container:${props.data.parent.kind}`,
    accept: acceptedTypesForData(props.data),
    data: props.data,
  });

  return (
    <div
      ref={droppable.ref}
      className={cn("relative", props.className)}
      data-sidebar-container-target={droppable.isDropTarget ? "true" : undefined}
    >
      {droppable.isDropTarget ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-1 top-0 z-30 h-[27px] rounded-md bg-[var(--color-background-accent)] ring-1 ring-inset ring-[var(--color-border-focus)]/70"
          data-sidebar-drop-indicator="inside"
        />
      ) : null}
      {props.children}
    </div>
  );
}
