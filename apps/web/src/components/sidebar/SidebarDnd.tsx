// FILE: SidebarDnd.tsx
// Purpose: Registers sidebar rows with the shell-wide current dnd-kit provider.

import { OptimisticSortingPlugin } from "@dnd-kit/dom/sortable";
import { useDragDropManager, useDragDropMonitor, useDroppable } from "@dnd-kit/react";
import { useSortable } from "@dnd-kit/react/sortable";
import type { DragEndEvent, DragOverEvent } from "@dnd-kit/react";
import type { ProviderKind, SidebarItemParent, SidebarItemReference } from "@penkra/contracts";
import { ContainerId, SpaceId } from "@penkra/contracts";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { cn } from "~/lib/utils";
import { FolderRowShared } from "../left-rail/folder-row-shared/FolderRowShared";
import { SpaceHeaderShared } from "../left-rail/space-header-shared/SpaceHeaderShared";
import {
  ThreadRowShared,
  type ThreadRowLevel,
} from "../left-rail/thread-row-shared/ThreadRowShared";
import type { WorkStatus } from "../left-rail/work-status-shared/WorkStatusShared";
import { DisclosureRegion } from "../ui/DisclosureRegion";

export const SIDEBAR_SPACE_DRAG_TYPE = "penkra/sidebar-space";
export const SIDEBAR_PROJECT_DRAG_TYPE = "penkra/sidebar-project";
export const SIDEBAR_THREAD_DRAG_TYPE = "penkra/sidebar-thread";

export type SidebarDropPlacement = "before" | "after";

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
// Folder containers surround their sortable thread rows. Keep the container below row
// collisions so a pointer over a thread preserves an exact before/after anchor, while the
// container still owns the folder header and empty-content area.
const SIDEBAR_FOLDER_CONTAINER_COLLISION_PRIORITY = 1;

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

export function canMoveSidebarItemToParent(
  item: SidebarItemReference,
  parent: SidebarItemParent,
): boolean {
  return item.kind === "project" ? parent.kind === "space" : parent.kind === "project";
}

export type SidebarItemDropTarget =
  | {
      parent: SidebarItemParent;
      targetKind: "container";
    }
  | {
      parent: SidebarItemParent;
      targetItem: SidebarItemReference;
      targetKind: "item";
    };

export type SidebarDropPreview =
  | {
      kind: "space";
      placement: SidebarDropPlacement;
      targetSpaceId: SpaceId;
    }
  | {
      kind: "item";
      anchorItem: SidebarItemReference | null;
      parent: SidebarItemParent;
      placement: SidebarDropPlacement;
      targetKind: "container" | "item";
    };

function areSidebarDropPreviewsEqual(
  left: SidebarDropPreview | null,
  right: SidebarDropPreview | null,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.kind !== right.kind) return false;
  if (left.kind === "space" && right.kind === "space") {
    return left.targetSpaceId === right.targetSpaceId && left.placement === right.placement;
  }
  if (left.kind !== "item" || right.kind !== "item") return false;
  const anchorsEqual =
    left.anchorItem === right.anchorItem ||
    (left.anchorItem !== null &&
      right.anchorItem !== null &&
      left.anchorItem.kind === right.anchorItem.kind &&
      left.anchorItem.id === right.anchorItem.id);
  return (
    anchorsEqual &&
    left.placement === right.placement &&
    left.targetKind === right.targetKind &&
    areSidebarItemParentsEqual(left.parent, right.parent)
  );
}

interface SidebarDropPreviewStore {
  getSnapshot: () => SidebarDropPreview | null;
  setSnapshot: (next: SidebarDropPreview | null) => void;
  subscribe: (listener: () => void) => () => void;
}

function createSidebarDropPreviewStore(): SidebarDropPreviewStore {
  let snapshot: SidebarDropPreview | null = null;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    setSnapshot(next) {
      if (areSidebarDropPreviewsEqual(snapshot, next)) return;
      snapshot = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const SidebarDropPreviewStoreContext = createContext<SidebarDropPreviewStore | null>(null);

function useSidebarDropPreviewSnapshot() {
  const store = useContext(SidebarDropPreviewStoreContext);
  return useSyncExternalStore(
    store?.subscribe ?? (() => () => undefined),
    store?.getSnapshot ?? (() => null),
    () => null,
  );
}

export function resolveSidebarItemDropTarget(
  sourceItem: SidebarItemReference,
  targetData: SidebarDndData | null,
): SidebarItemDropTarget | null {
  if (targetData?.type === "container") {
    return canMoveSidebarItemToParent(sourceItem, targetData.parent)
      ? { parent: targetData.parent, targetKind: "container" }
      : null;
  }
  if (targetData?.type !== "item") return null;
  if (sourceItem.kind === targetData.item.kind && sourceItem.id === targetData.item.id) return null;
  return canMoveSidebarItemToParent(sourceItem, targetData.parent)
    ? { parent: targetData.parent, targetItem: targetData.item, targetKind: "item" }
    : null;
}

export function acceptedTypesForData(data: SidebarDndData): string[] {
  if (data.type === "space") return [SIDEBAR_SPACE_DRAG_TYPE];
  if (data.type === "container") {
    return data.parent.kind === "space"
      ? [...SIDEBAR_PROJECT_DRAG_TYPES]
      : [...SIDEBAR_THREAD_DRAG_TYPES];
  }
  const pinned = data.preview.pinned;
  return data.item.kind === "project"
    ? [sidebarItemDragType("project", pinned)]
    : [sidebarItemDragType("thread", pinned)];
}

export function areSidebarItemParentsEqual(
  left: SidebarItemParent,
  right: SidebarItemParent,
): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === "space"
    ? left.spaceId === (right.kind === "space" ? right.spaceId : null)
    : left.projectId === (right.kind === "project" ? right.projectId : null);
}

export function canUseSidebarSortableTarget(
  sourceData: SidebarDndData | null,
  targetData: SidebarDndData,
): boolean {
  if (!sourceData) return false;
  if (sourceData.type === "space" || targetData.type === "space") {
    return sourceData.type === "space" && targetData.type === "space";
  }
  if (sourceData.type !== "item" || targetData.type !== "item") return false;
  return acceptedTypesForData(targetData).includes(dragTypeForData(sourceData));
}

export function SidebarDndMonitor(props: {
  children: ReactNode;
  onDragEnd: (event: DragEndEvent) => void;
  onDragOver: (
    event: Pick<DragOverEvent, "operation">,
    placement: SidebarDropPlacement,
  ) => SidebarDropPreview | null | undefined;
}) {
  const manager = useDragDropManager();
  const previewStoreRef = useRef<SidebarDropPreviewStore | null>(null);
  previewStoreRef.current ??= createSidebarDropPreviewStore();
  const previewStore = previewStoreRef.current;
  const pendingFrameRef = useRef<number | null>(null);
  const pendingPreviewFrameRef = useRef<number | null>(null);
  const pendingPreviewRef = useRef<SidebarDropPreview | null>(null);
  const latestPointerYRef = useRef<number | null>(null);
  const updatePreview = (next: SidebarDropPreview | null | undefined) => {
    if (next === undefined) return;
    pendingPreviewRef.current = next;
    if (pendingPreviewFrameRef.current !== null) return;
    pendingPreviewFrameRef.current = requestAnimationFrame(() => {
      pendingPreviewFrameRef.current = null;
      previewStore.setSnapshot(pendingPreviewRef.current);
    });
  };
  useEffect(
    () => () => {
      if (pendingFrameRef.current !== null) cancelAnimationFrame(pendingFrameRef.current);
      if (pendingPreviewFrameRef.current !== null) {
        cancelAnimationFrame(pendingPreviewFrameRef.current);
      }
      previewStore.setSnapshot(null);
    },
    [],
  );
  useDragDropMonitor({
    onDragMove(event) {
      latestPointerYRef.current =
        typeof MouseEvent !== "undefined" && event.nativeEvent instanceof MouseEvent
          ? event.nativeEvent.clientY
          : null;
      updatePreview(props.onDragOver(event, resolveSidebarDropPlacement(event)));
    },
    onDragOver(event) {
      updatePreview(
        props.onDragOver(
          event,
          resolveSidebarDropPlacement(event, latestPointerYRef.current ?? undefined),
        ),
      );
    },
    onDragEnd(event) {
      latestPointerYRef.current = null;
      updatePreview(null);
      // Commit after the operation reaches its public idle state so authoritative
      // sidebar state never races the drag source and overlay cleanup.
      const commitAfterDomRestore = () => {
        if (!manager || manager.dragOperation.status.idle) {
          pendingFrameRef.current = null;
          props.onDragEnd(event);
          return;
        }
        pendingFrameRef.current = requestAnimationFrame(commitAfterDomRestore);
      };
      pendingFrameRef.current = requestAnimationFrame(commitAfterDomRestore);
    },
  });
  return (
    <SidebarDropPreviewStoreContext.Provider value={previewStore}>
      {props.children}
    </SidebarDropPreviewStoreContext.Provider>
  );
}

export function resolveSidebarDropPlacement(
  event: Pick<DragOverEvent, "operation"> & { nativeEvent?: Event },
  pointerY?: number,
): SidebarDropPlacement {
  const target = event.operation.target;
  const targetElement = target?.element;
  const placementElement =
    targetElement && typeof targetElement.querySelector === "function"
      ? (targetElement.querySelector("button") ?? targetElement)
      : targetElement;
  // dnd-kit owns the geometry used for collision detection. Prefer that measured
  // shape so our feedback padding cannot move the live DOM midpoint underneath a
  // stationary pointer and flip an already-resolved before/after placement.
  const targetRect = target?.shape?.boundingRectangle ?? placementElement?.getBoundingClientRect();
  if (!targetRect || targetRect.height <= 0) return "before";
  const resolvedPointerY =
    pointerY ??
    (typeof MouseEvent !== "undefined" && event.nativeEvent instanceof MouseEvent
      ? event.nativeEvent.clientY
      : event.operation.position.current.y);
  return resolvedPointerY >= targetRect.top + targetRect.height / 2 ? "after" : "before";
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
    // With optimistic DOM sorting disabled, row targets are safe across parents:
    // they provide precise before/after anchors without reparenting React-owned DOM.
    accept: (source) =>
      source.id !== props.id &&
      canUseSidebarSortableTarget(readSidebarDndData(source.data), props.data),
    data: props.data,
    // Sidebar order is server-authoritative. dnd-kit's optimistic plugin physically
    // moves React-owned DOM nodes and can leave the moved node behind when a thread
    // changes folders. Keep collision/drag behavior, but commit semantic targets only.
    plugins: (defaults) => defaults.filter((plugin) => plugin !== OptimisticSortingPlugin),
    transition: { duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" },
  });
  const sortableRef = sortable.ref;
  const sortableHandleRef = sortable.handleRef;
  const setNodeRef = useCallback(
    (element: Element | null) => {
      sortableRef(element);
      // Keep the layout wrapper inert. Every sidebar node already owns an accessible
      // row/header button, so registering that existing control as the handle avoids
      // introducing a second tab stop or a nested synthetic button role.
      sortableHandleRef(element?.querySelector("button") ?? element);
    },
    [sortableHandleRef, sortableRef],
  );

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
      <SidebarDropFeedbackFrame data={props.data}>{props.children}</SidebarDropFeedbackFrame>
    </div>
  );
}

function SidebarDropFeedbackFrame(props: { children: ReactNode; data: SidebarDndData }) {
  const preview = useSidebarDropPreviewSnapshot();
  const dropGap =
    preview?.kind === "space" && props.data.type === "space"
      ? preview.targetSpaceId === props.data.spaceId
        ? preview.placement
        : null
      : preview?.kind === "item" && props.data.type === "item" && preview.anchorItem
        ? areSidebarItemParentsEqual(preview.parent, props.data.parent) &&
          preview.anchorItem.kind === props.data.item.kind &&
          preview.anchorItem.id === props.data.item.id
          ? preview.placement
          : null
        : null;

  return (
    <div
      className={cn(
        "relative transition-[padding] duration-150 [transition-timing-function:ease] motion-reduce:transition-none",
        dropGap === "before" ? "pt-7" : "pt-0",
        dropGap === "after" ? "pb-7" : "pb-0",
      )}
      data-sidebar-drop-preview={dropGap ?? undefined}
    >
      {dropGap ? (
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-x-2 z-30 h-0.5 rounded-full bg-[var(--color-border-focus)]",
            dropGap === "before" ? "top-3.5" : "bottom-3.5",
          )}
          data-sidebar-drop-indicator={dropGap}
        />
      ) : null}
      {props.children}
    </div>
  );
}

export function SidebarContainerDropPreview(props: {
  enabled?: boolean;
  parent: SidebarItemParent;
}) {
  const preview = useSidebarDropPreviewSnapshot();
  const open =
    props.enabled !== false &&
    preview?.kind === "item" &&
    preview.targetKind === "container" &&
    areSidebarItemParentsEqual(preview.parent, props.parent);
  return (
    <DisclosureRegion open={open}>
      <div
        aria-hidden="true"
        className="relative h-7"
        data-sidebar-container-drop-preview={open ? "true" : undefined}
      >
        <div className="absolute inset-x-2 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-[var(--color-border-focus)]" />
      </div>
    </DisclosureRegion>
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
    ...(props.data.parent.kind === "project"
      ? { collisionPriority: SIDEBAR_FOLDER_CONTAINER_COLLISION_PRIORITY }
      : {}),
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
