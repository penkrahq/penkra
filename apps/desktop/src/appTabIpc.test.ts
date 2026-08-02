import { describe, expect, it } from "vitest";

import {
  parseAppTabIdRequest,
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
    expect(parseSetAppTabVisibleRequest({ tabId: "tab", visible: true })).toEqual({
      tabId: "tab",
      visible: true,
    });
    expect(
      parseSetAppTabBoundsRequest({ tabId: "tab", bounds: { x: 1, y: 2, width: 3, height: 4 } }),
    ).toEqual({ tabId: "tab", bounds: { x: 1, y: 2, width: 3, height: 4 } });
  });

  it("rejects missing identities and non-finite geometry", () => {
    expect(() => parseOpenAppTabRequest({ appId: "app" })).toThrow();
    expect(() => parseOpenAppFromAppsRequest({ appId: "" })).toThrow();
    expect(() => parseSetAppTabVisibleRequest({ tabId: "tab", visible: "yes" })).toThrow();
    expect(() =>
      parseSetAppTabBoundsRequest({
        tabId: "tab",
        bounds: { x: 0, y: 0, width: Infinity, height: 4 },
      }),
    ).toThrow();
  });
});
