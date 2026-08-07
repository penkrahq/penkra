import { describe, expect, it } from "vitest";

import {
  appTabCssBoundsToNativeBounds,
  parseAppTabIdRequest,
  parseAppTabRendererRequest,
  parseAppTabRouteRequest,
  parseNavigateAppTabRequest,
  parseOpenAppFromAppsRequest,
  parseOpenAppTabRequest,
  parseSetAppTabBoundsRequest,
  parseSetAppTabVisibleRequest,
} from "./appTabIpc";

describe("App tab IPC boundary", () => {
  it("parses lifecycle requests without coercion", () => {
    expect(
      parseOpenAppTabRequest({ appId: "app", spaceId: "space", threadId: "thread", route: "/" }),
    ).toEqual({ appId: "app", spaceId: "space", threadId: "thread", route: "/" });
    expect(parseOpenAppFromAppsRequest({ appId: "target" })).toEqual({ appId: "target" });
    expect(parseAppTabIdRequest({ tabId: "tab" })).toEqual({ tabId: "tab" });
    expect(parseAppTabRendererRequest({ tabId: "tab", rendererId: 17 })).toEqual({
      tabId: "tab",
      rendererId: 17,
    });
    expect(parseAppTabRouteRequest({ route: "/document", state: { id: "7" } })).toEqual({
      route: "/document",
      state: { id: "7" },
    });
    expect(parseNavigateAppTabRequest({ tabId: "tab", route: "/document" })).toEqual({
      tabId: "tab",
      route: "/document",
    });
    expect(parseSetAppTabVisibleRequest({ tabId: "tab", rendererId: 17, visible: true })).toEqual({
      tabId: "tab",
      rendererId: 17,
      visible: true,
    });
    expect(
      parseSetAppTabBoundsRequest({
        tabId: "tab",
        rendererId: 17,
        bounds: { x: 1, y: 2, width: 3, height: 4 },
      }),
    ).toEqual({
      tabId: "tab",
      rendererId: 17,
      bounds: { x: 1, y: 2, width: 3, height: 4 },
    });
  });

  it("rejects missing identities and non-finite geometry", () => {
    expect(() => parseOpenAppTabRequest({ appId: "app" })).toThrow();
    expect(() => parseOpenAppFromAppsRequest({ appId: "" })).toThrow();
    expect(() => parseAppTabRouteRequest({ route: "" })).toThrow();
    expect(() =>
      parseSetAppTabVisibleRequest({ tabId: "tab", rendererId: 17, visible: "yes" }),
    ).toThrow();
    expect(() => parseAppTabRendererRequest({ tabId: "tab", rendererId: NaN })).toThrow();
    expect(() =>
      parseSetAppTabBoundsRequest({
        tabId: "tab",
        rendererId: 17,
        bounds: { x: 0, y: 0, width: Infinity, height: 4 },
      }),
    ).toThrow();
  });

  it("converts shell CSS geometry into native View geometry at page zoom", () => {
    expect(
      appTabCssBoundsToNativeBounds({ x: 984, y: 58, width: 744, height: 900 }, Math.sqrt(1.2)),
    ).toEqual({
      x: 984 * Math.sqrt(1.2),
      y: 58 * Math.sqrt(1.2),
      width: 744 * Math.sqrt(1.2),
      height: 900 * Math.sqrt(1.2),
    });
    expect(() => appTabCssBoundsToNativeBounds({ x: 0, y: 0, width: 1, height: 1 }, 0)).toThrow(
      "Invalid App tab zoom factor",
    );
  });
});
