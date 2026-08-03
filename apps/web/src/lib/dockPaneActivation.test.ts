import { ThreadId } from "@penkra/contracts";
import { describe, expect, it } from "vitest";

import {
  DOCK_PANE_DEFERRED_HYDRATION_FRAMES,
  dockPaneActivationKey,
  isDeferredRuntimePaneKind,
  isKeepMountedPaneKind,
  reconcileKeepMountedPaneIds,
  resolveDockPaneRuntimeMode,
} from "./dockPaneActivation";

describe("dockPaneActivation", () => {
  it("treats sidechat panes as deferred runtime panes", () => {
    expect(isDeferredRuntimePaneKind("sidechat")).toBe(true);
    expect(isDeferredRuntimePaneKind("diff")).toBe(false);
    expect(isDeferredRuntimePaneKind("git")).toBe(false);
  });

  it("keeps light panes live even when restored from persisted state", () => {
    expect(resolveDockPaneRuntimeMode({ kind: "diff", reason: "restore", hydrated: false })).toBe(
      "live",
    );
    expect(resolveDockPaneRuntimeMode({ kind: "git", reason: "restore", hydrated: false })).toBe(
      "live",
    );
  });

  it("previews restored heavy panes until they are hydrated", () => {
    expect(
      resolveDockPaneRuntimeMode({ kind: "sidechat", reason: "restore", hydrated: false }),
    ).toBe("preview");
    expect(
      resolveDockPaneRuntimeMode({ kind: "sidechat", reason: "restore", hydrated: true }),
    ).toBe("live");
  });

  it("hydrates heavy panes immediately after explicit user actions", () => {
    expect(
      resolveDockPaneRuntimeMode({ kind: "sidechat", reason: "explicit", hydrated: false }),
    ).toBe("live");
    expect(
      resolveDockPaneRuntimeMode({ kind: "sidechat", reason: "explicit", hydrated: false }),
    ).toBe("live");
  });

  it("builds a stable pane key scoped by host thread, pane id, and kind", () => {
    expect(
      dockPaneActivationKey({
        threadId: ThreadId.makeUnsafe("thread-1"),
        paneId: "pane-1",
        kind: "app",
      }),
    ).toBe("thread-1\u0000pane-1\u0000app");
  });

  it("uses two frames for restored heavy-pane hydration", () => {
    expect(DOCK_PANE_DEFERRED_HYDRATION_FRAMES).toBe(2);
  });

  it("does not preserve inactive pane subtrees", () => {
    expect(isKeepMountedPaneKind("app")).toBe(false);
    expect(isKeepMountedPaneKind("sidechat")).toBe(false);
    expect(isKeepMountedPaneKind("diff")).toBe(false);
    expect(isKeepMountedPaneKind("git")).toBe(false);
  });

  describe("reconcileKeepMountedPaneIds", () => {
    const panes = [{ id: "diff", kind: "diff" as const }];

    it("does not add an active pane when no pane kind requires preservation", () => {
      expect([
        ...reconcileKeepMountedPaneIds({
          previous: new Set(),
          panes,
          activePaneId: "diff",
          activePaneKind: "diff",
        }),
      ]).toEqual([]);
    });

    it("drops stale preserved ids", () => {
      const result = reconcileKeepMountedPaneIds({
        previous: new Set(["removed-pane"]),
        panes,
        activePaneId: "diff",
        activePaneKind: "diff",
      });
      expect(result.size).toBe(0);
    });

    it("drops kept ids that no longer exist (closed pane or thread switch)", () => {
      const result = reconcileKeepMountedPaneIds({
        previous: new Set(["removed-pane", "stale"]),
        panes: [{ id: "diff", kind: "diff" as const }],
        activePaneId: "diff",
        activePaneKind: "diff",
      });
      expect(result.has("removed-pane")).toBe(false);
      expect(result.has("stale")).toBe(false);
    });

    it("ignores an active id that is not in the live pane list", () => {
      const result = reconcileKeepMountedPaneIds({
        previous: new Set(),
        panes,
        activePaneId: "ghost",
        activePaneKind: "diff",
      });
      expect(result.size).toBe(0);
    });
  });
});
