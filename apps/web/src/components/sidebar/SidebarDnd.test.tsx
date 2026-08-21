import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { SidebarDndData } from "./SidebarDnd";
import {
  acceptedTypesForData,
  areSidebarItemParentsEqual,
  canMoveSidebarItemToParent,
  canUseSidebarSortableTarget,
  dragTypeForData,
  resolveSidebarDropPlacement,
  resolveSidebarItemDropTarget,
  SidebarDragPreview,
} from "./SidebarDnd";
import type { DragOverEvent } from "@dnd-kit/react";

function itemData(kind: "project" | "thread", pinned: boolean): SidebarDndData {
  return {
    type: "item",
    item: { kind, id: `${kind}-${pinned}` as never },
    parent:
      kind === "project"
        ? { kind: "space", spaceId: "space" as never }
        : { kind: "project", projectId: "project" as never },
    label: kind,
    preview:
      kind === "project"
        ? { kind, label: kind, expanded: false, pinned, workStatus: "idle" }
        : {
            kind,
            label: kind,
            harness: "codex",
            level: "root",
            pinned,
            workStatus: "idle",
          },
  };
}

describe("SidebarDragPreview", () => {
  it("renders a folder as a complete sidebar row", () => {
    const markup = renderToStaticMarkup(
      <SidebarDragPreview
        preview={{
          kind: "project",
          label: "Release planning",
          expanded: true,
          pinned: true,
          workStatus: "running",
        }}
      />,
    );

    expect(markup).toContain('data-slot="left-rail-leading"');
    expect(markup).toContain('data-slot="folder-state-icon"');
    expect(markup).toContain('data-pinned="true"');
    expect(markup).toContain("Release planning");
  });

  it("preserves a thread's leading icon, nesting, pin, and status", () => {
    const markup = renderToStaticMarkup(
      <SidebarDragPreview
        preview={{
          kind: "thread",
          label: "Fix drag preview",
          harness: "github",
          level: "nested",
          pinned: true,
          workStatus: "attention",
        }}
      />,
    );

    expect(markup).toContain('data-slot="left-rail-leading"');
    expect(markup).toContain('data-thread-level="nested"');
    expect(markup).toContain('data-pinned="true"');
    expect(markup).toContain('data-work-status="attention"');
    expect(markup).toContain("Fix drag preview");
  });

  it("keeps sortable targets inside the same item kind and pin partition", () => {
    const unpinnedTarget = itemData("project", false);

    expect(acceptedTypesForData(unpinnedTarget)).toContain(
      dragTypeForData(itemData("project", false)),
    );
    expect(acceptedTypesForData(unpinnedTarget)).not.toContain(
      dragTypeForData(itemData("thread", false)),
    );
    expect(acceptedTypesForData(unpinnedTarget)).not.toContain(
      dragTypeForData(itemData("thread", true)),
    );
    expect(acceptedTypesForData(unpinnedTarget)).not.toContain(
      dragTypeForData(itemData("project", true)),
    );
  });

  it("allows compatible row anchors across React-owned parents", () => {
    const source = itemData("thread", false);
    const sameFolder = itemData("thread", false);
    const otherFolder = itemData("thread", false);
    if (source.type !== "item" || sameFolder.type !== "item" || otherFolder.type !== "item") {
      throw new Error("Expected items");
    }
    source.item = { kind: "thread", id: "source" as never };
    sameFolder.item = { kind: "thread", id: "same-folder" as never };
    otherFolder.item = { kind: "thread", id: "other-folder" as never };
    otherFolder.parent = { kind: "project", projectId: "other-project" as never };

    expect(canUseSidebarSortableTarget(source, sameFolder)).toBe(true);
    expect(canUseSidebarSortableTarget(source, otherFolder)).toBe(true);
    expect(areSidebarItemParentsEqual(source.parent, sameFolder.parent)).toBe(true);
    expect(areSidebarItemParentsEqual(source.parent, otherFolder.parent)).toBe(false);
  });

  it("keeps explicit space containers available only to folders in both pin partitions", () => {
    const container: SidebarDndData = {
      type: "container",
      parent: { kind: "space", spaceId: "space" as never },
      label: "Space",
    };

    expect(acceptedTypesForData(container)).toContain(dragTypeForData(itemData("project", true)));
    expect(acceptedTypesForData(container)).toContain(dragTypeForData(itemData("project", false)));
    expect(acceptedTypesForData(container)).not.toContain(
      dragTypeForData(itemData("thread", true)),
    );
    expect(acceptedTypesForData(container)).not.toContain(
      dragTypeForData(itemData("thread", false)),
    );
  });

  it("keeps explicit folder containers available only to threads", () => {
    const container: SidebarDndData = {
      type: "container",
      parent: { kind: "project", projectId: "project" as never },
      label: "Project",
    };

    expect(acceptedTypesForData(container)).toContain(dragTypeForData(itemData("thread", true)));
    expect(acceptedTypesForData(container)).toContain(dragTypeForData(itemData("thread", false)));
    expect(acceptedTypesForData(container)).not.toContain(
      dragTypeForData(itemData("project", false)),
    );
  });

  it("allows folders only in Spaces and threads only in folders", () => {
    expect(
      canMoveSidebarItemToParent(
        { kind: "project", id: "project" as never },
        { kind: "space", spaceId: "space" as never },
      ),
    ).toBe(true);
    expect(
      canMoveSidebarItemToParent(
        { kind: "project", id: "project" as never },
        { kind: "project", projectId: "other" as never },
      ),
    ).toBe(false);
    expect(
      canMoveSidebarItemToParent(
        { kind: "thread", id: "thread" as never },
        { kind: "project", projectId: "project" as never },
      ),
    ).toBe(true);
    expect(
      canMoveSidebarItemToParent(
        { kind: "thread", id: "thread" as never },
        { kind: "space", spaceId: "space" as never },
      ),
    ).toBe(false);
  });

  it("resolves only compatible semantic drop targets", () => {
    const thread = itemData("thread", false);
    const project = itemData("project", false);
    if (thread.type !== "item" || project.type !== "item") throw new Error("Expected items");

    expect(
      resolveSidebarItemDropTarget(thread.item, {
        type: "container",
        parent: { kind: "project", projectId: "destination" as never },
        label: "Destination",
      }),
    ).toEqual({
      parent: { kind: "project", projectId: "destination" },
      targetKind: "container",
    });
    expect(resolveSidebarItemDropTarget(thread.item, project)).toBeNull();
    expect(resolveSidebarItemDropTarget(thread.item, thread)).toBeNull();

    const siblingThread = itemData("thread", false);
    if (siblingThread.type !== "item") throw new Error("Expected item");
    siblingThread.item = { kind: "thread", id: "sibling" as never };
    expect(resolveSidebarItemDropTarget(thread.item, siblingThread)).toEqual({
      parent: siblingThread.parent,
      targetItem: siblingThread.item,
      targetKind: "item",
    });
  });

  it("derives before and after placement from the target row midpoint", () => {
    const eventAt = (y: number) =>
      ({
        operation: {
          position: { current: { x: 0, y } },
          target: {
            element: {
              getBoundingClientRect: () => ({ height: 24, top: 100 }),
            },
          },
        },
      }) as unknown as DragOverEvent;

    expect(resolveSidebarDropPlacement(eventAt(111))).toBe("before");
    expect(resolveSidebarDropPlacement(eventAt(112))).toBe("after");
  });

  it("uses dnd-kit's measured target shape when feedback has shifted the live DOM", () => {
    const event = {
      operation: {
        position: { current: { x: 0, y: 0 } },
        target: {
          element: {
            querySelector: () => null,
            getBoundingClientRect: () => ({ height: 24, top: 80 }),
          },
          shape: {
            boundingRectangle: {
              bottom: 124,
              height: 24,
              left: 0,
              right: 100,
              top: 100,
              width: 100,
            },
          },
        },
      },
    } as unknown as DragOverEvent;

    expect(resolveSidebarDropPlacement(event, 110)).toBe("before");
  });
});
