import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { SidebarDndData } from "./SidebarDnd";
import { acceptedTypesForData, dragTypeForData, SidebarDragPreview } from "./SidebarDnd";

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

  it("rejects pinned and unpinned rows as each other's sortable targets", () => {
    const item = (kind: "project" | "thread", pinned: boolean): SidebarDndData => ({
      type: "item",
      item: { kind, id: `${kind}-${pinned}` as never },
      parent: { kind: "space", spaceId: "space" as never },
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
    });
    const unpinnedTarget = item("project", false);

    expect(acceptedTypesForData(unpinnedTarget)).toContain(dragTypeForData(item("thread", false)));
    expect(acceptedTypesForData(unpinnedTarget)).not.toContain(
      dragTypeForData(item("thread", true)),
    );
    expect(acceptedTypesForData(unpinnedTarget)).not.toContain(
      dragTypeForData(item("project", true)),
    );
  });

  it("keeps explicit space containers available to both pin partitions", () => {
    const container: SidebarDndData = {
      type: "container",
      parent: { kind: "space", spaceId: "space" as never },
      label: "Space",
    };
    const pinnedThread: SidebarDndData = {
      type: "item",
      item: { kind: "thread", id: "pinned" as never },
      parent: { kind: "space", spaceId: "space" as never },
      label: "Pinned",
      preview: {
        kind: "thread",
        label: "Pinned",
        harness: "codex",
        level: "root",
        pinned: true,
        workStatus: "idle",
      },
    };
    const unpinnedThread: SidebarDndData = {
      ...pinnedThread,
      item: { kind: "thread", id: "unpinned" as never },
      preview: { ...pinnedThread.preview, pinned: false },
    };

    expect(acceptedTypesForData(container)).toContain(dragTypeForData(pinnedThread));
    expect(acceptedTypesForData(container)).toContain(dragTypeForData(unpinnedThread));
  });
});
