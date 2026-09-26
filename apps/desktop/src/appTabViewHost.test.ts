import { describe, expect, it, vi } from "vitest";

import {
  detachedHostPlatformPolicy,
  detachedHostLayoutBounds,
  clipAppTabBounds,
  hasRegisteredShellWindow,
  dockTransitionProgress,
  resolveAppTabPresentationMode,
  restoreShellFocusAfterHide,
  shouldApplyAppTabHide,
  shouldKeepNativeAppViewVisible,
  shouldKeepPresentationAnimation,
  shouldPresentAppView,
} from "./appTabViewHost";

describe("restoreShellFocusAfterHide", () => {
  it("refocuses the shell only while its owning OS window is focused", () => {
    const focus = vi.fn();
    const window = { isDestroyed: () => false, isFocused: () => false, webContents: { focus } };
    expect(restoreShellFocusAfterHide(window)).toBe(false);
    expect(focus).not.toHaveBeenCalled();
    expect(restoreShellFocusAfterHide({ ...window, isFocused: () => true })).toBe(true);
    expect(focus).toHaveBeenCalledOnce();
    expect(restoreShellFocusAfterHide({ ...window, isDestroyed: () => true })).toBe(false);
    expect(focus).toHaveBeenCalledOnce();
  });
});

describe("detachedHostPlatformPolicy", () => {
  const displays = [
    { x: -1920, y: 0, width: 1920, height: 1080 },
    { x: 0, y: -200, width: 1440, height: 900 },
  ];

  it.each(["darwin", "win32"] as const)(
    "keeps detached hosts available without forwarding user input on %s",
    (platform) => {
      expect(detachedHostPlatformPolicy({ platform, displays })).toEqual({
        visibleHost: true,
        canDeliverPointerInput: true,
        placement: { x: 0, y: 0 },
        useSkipTaskbar: true,
        useNonFocusableWindow: true,
        forwardUserMouseEvents: false,
      });
    },
  );

  it("keeps Linux detached hosts hidden and rejects unverified pointer delivery", () => {
    const policy = detachedHostPlatformPolicy({ platform: "linux", displays });
    expect(policy.visibleHost).toBe(false);
    expect(policy.canDeliverPointerInput).toBe(false);
    expect(policy.placement).toEqual({ x: 11_440, y: 10_000 });
    expect(policy.useSkipTaskbar).toBe(false);
    expect(policy.useNonFocusableWindow).toBe(false);
    expect(policy.forwardUserMouseEvents).toBe(false);
  });
});

describe("hasRegisteredShellWindow", () => {
  it("uses WebContents IDs and keeps hosts while either of two shells remains", () => {
    const firstShell = { id: 2, webContents: { id: 101 } };
    const secondShell = { id: 3, webContents: { id: 202 } };
    const detachedHost = { id: 4, webContents: { id: 303 } };
    const registry = new Map([
      [firstShell.webContents.id, firstShell],
      [secondShell.webContents.id, secondShell],
    ]);
    const lookup = vi.fn((rendererId: number) => registry.get(rendererId) ?? null);

    registry.delete(firstShell.webContents.id);
    expect(hasRegisteredShellWindow([secondShell, detachedHost], lookup)).toBe(true);
    expect(lookup.mock.calls.map(([rendererId]) => rendererId)).toEqual([202]);

    registry.delete(secondShell.webContents.id);
    registry.set(detachedHost.webContents.id, detachedHost);
    const hosts = new Set([detachedHost]);
    expect(hasRegisteredShellWindow([detachedHost], lookup, hosts)).toBe(false);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(hasRegisteredShellWindow([secondShell, detachedHost], lookup, hosts)).toBe(false);
    registry.set(firstShell.webContents.id, firstShell);
    expect(hasRegisteredShellWindow([firstShell, detachedHost], lookup, hosts)).toBe(true);
  });
});

describe("detached host mouse behavior", () => {
  it("disables mouse events without enabling forwarding", async () => {
    const { setDetachedHostMousePassthrough } = await import("./appTabViewHost");
    const setIgnoreMouseEvents = vi.fn();
    setDetachedHostMousePassthrough({ setIgnoreMouseEvents });
    expect(setIgnoreMouseEvents).toHaveBeenCalledExactlyOnceWith(true);
  });
});

describe("detachedHostLayoutBounds", () => {
  it("keeps both Browser documents at their own host origin", () => {
    expect(detachedHostLayoutBounds({ x: 920, y: 48, width: 600, height: 700 }, 48)).toEqual({
      app: { x: 0, y: 0, width: 600, height: 700 },
      page: { x: 0, y: -48, width: 600, height: 700 },
    });
  });
});

describe("resolveAppTabPresentationMode", () => {
  it("uses the captured replica while the owner window is hidden", () => {
    expect(
      resolveAppTabPresentationMode({
        ownsWindow: true,
        presentationVisible: true,
        windowVisible: false,
        hasReplica: true,
      }),
    ).toBe("replica");
  });

  it("keeps a selected owner live while its window is visible", () => {
    expect(
      resolveAppTabPresentationMode({
        ownsWindow: true,
        presentationVisible: true,
        windowVisible: true,
        hasReplica: true,
      }),
    ).toBe("live");
  });

  it("hides an inactive presentation even when a replica exists", () => {
    expect(
      resolveAppTabPresentationMode({
        ownsWindow: true,
        presentationVisible: false,
        windowVisible: false,
        hasReplica: true,
      }),
    ).toBe("hidden");
  });
});

describe("shouldKeepNativeAppViewVisible", () => {
  it("keeps a selected native view composited with its hidden parent window", () => {
    expect(shouldKeepNativeAppViewVisible({ visibleRequested: true, freezeDepth: 0 })).toBe(true);
  });

  it("hides deselected and frozen native views", () => {
    expect(shouldKeepNativeAppViewVisible({ visibleRequested: false, freezeDepth: 0 })).toBe(false);
    expect(shouldKeepNativeAppViewVisible({ visibleRequested: true, freezeDepth: 1 })).toBe(false);
  });
});

describe("dockTransitionProgress", () => {
  it("matches the shell dock cubic-bezier checkpoints", () => {
    expect(dockTransitionProgress(0)).toBe(0);
    expect(dockTransitionProgress(0.25)).toBeCloseTo(0.7791, 3);
    expect(dockTransitionProgress(0.5)).toBeCloseTo(0.9548, 3);
    expect(dockTransitionProgress(1)).toBe(1);
  });
});

const visible = {
  selected: true,
  attached: true,
  windowVisible: true,
  painted: true,
  threadOnScreen: true,
  bounds: { x: 700, y: 40, width: 500, height: 760 },
};

describe("AppTabViewHost presentation states", () => {
  it.each([
    ["visible", {}, true],
    ["hidden", { selected: false }, false],
    ["zero-bounds", { bounds: { x: 0, y: 0, width: 0, height: 0 } }, false],
    ["detached", { attached: false }, false],
    ["window-hidden", { windowVisible: false }, false],
    ["never-painted", { painted: false }, false],
    ["thread-not-on-screen", { threadOnScreen: false }, false],
  ] as const)("resolves %s", (_name, patch, expected) => {
    expect(shouldPresentAppView({ ...visible, ...patch })).toBe(expected);
  });
});

describe("shouldApplyAppTabHide", () => {
  it("rejects an asynchronous hide superseded by a newer presentation", () => {
    expect(shouldApplyAppTabHide({ selectedAt: 12, visible: true }, 11)).toBe(false);
    expect(shouldApplyAppTabHide({ selectedAt: 12, visible: false }, 11)).toBe(false);
  });

  it("applies the hide while its exact presentation remains inactive", () => {
    expect(shouldApplyAppTabHide({ selectedAt: 11, visible: false }, 11)).toBe(true);
    expect(shouldApplyAppTabHide(undefined, null)).toBe(true);
  });
});

describe("shouldKeepPresentationAnimation", () => {
  const bounds = { x: 700, y: 40, width: 500, height: 760 };

  it("keeps an in-flight dock reveal when duplicate geometry is published", () => {
    expect(
      shouldKeepPresentationAnimation({
        animating: true,
        ownerWindowId: 9,
        requestedWindowId: 9,
        currentBounds: bounds,
        requestedBounds: { ...bounds },
      }),
    ).toBe(true);
  });

  it("allows a real geometry change to replace the in-flight animation", () => {
    expect(
      shouldKeepPresentationAnimation({
        animating: true,
        ownerWindowId: 9,
        requestedWindowId: 9,
        currentBounds: bounds,
        requestedBounds: { ...bounds, width: bounds.width + 1 },
      }),
    ).toBe(false);
  });
});

describe("clipAppTabBounds", () => {
  const viewport = { x: 0, y: 0, width: 840, height: 600 };

  it("retains a host rect below the former dock minimum", () => {
    expect(clipAppTabBounds({ x: 640, y: 46, width: 180, height: 500 }, viewport)).toEqual({
      x: 640,
      y: 46,
      width: 180,
      height: 500,
    });
  });

  it("clips the host rect to the viewport without moving its left edge", () => {
    expect(clipAppTabBounds({ x: 640, y: 46, width: 300, height: 700 }, viewport)).toEqual({
      x: 640,
      y: 46,
      width: 200,
      height: 554,
    });
  });

  it("does not expand a previously measured view after a window grows", () => {
    const host = { x: 640, y: 46, width: 180, height: 500 };
    expect(clipAppTabBounds(host, { x: 0, y: 0, width: 1200, height: 800 })).toEqual(host);
    expect(clipAppTabBounds(host, viewport)).toEqual(host);
  });

  it("returns no native view when the host is outside the viewport", () => {
    expect(clipAppTabBounds({ x: 900, y: 46, width: 180, height: 500 }, viewport)).toBeNull();
  });
});
