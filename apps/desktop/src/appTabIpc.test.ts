import { describe, expect, it } from "vitest";

import {
  parseAppTabIdRequest,
  parseAppTabRendererRequest,
  parseAppTabRouteRequest,
  parseNavigateAppTabRequest,
  parseOpenAppFromAppsRequest,
  parseOpenAppTabRequest,
  parseSetAppTabActiveRequest,
} from "./appTabIpc";

describe("App tab IPC boundary", () => {
  it("parses lifecycle requests without coercion", () => {
    expect(
      parseOpenAppTabRequest({
        appId: "app",
        spaceId: "space",
        deckId: "deck",
        threadId: "thread",
        route: "/",
      }),
    ).toEqual({
      appId: "app",
      spaceId: "space",
      deckId: "deck",
      threadId: "thread",
      route: "/",
    });
    expect(
      parseOpenAppTabRequest({
        tabId: "stable-tab",
        appId: "app",
        spaceId: "space",
        deckId: "deck",
        threadId: "thread",
        route: "/",
      }),
    ).toEqual({
      tabId: "stable-tab",
      appId: "app",
      spaceId: "space",
      deckId: "deck",
      threadId: "thread",
      route: "/",
    });
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
    expect(
      parseSetAppTabActiveRequest({
        tabId: "tab",
        rendererId: 17,
        active: true,
        deckId: "deck-1",
        threadId: "thread-1",
      }),
    ).toEqual({
      tabId: "tab",
      rendererId: 17,
      active: true,
      deckId: "deck-1",
      threadId: "thread-1",
    });
  });

  it("rejects missing identities and non-finite geometry", () => {
    expect(() => parseOpenAppTabRequest({ appId: "app" })).toThrow();
    expect(() => parseOpenAppFromAppsRequest({ appId: "" })).toThrow();
    expect(() => parseAppTabRouteRequest({ route: "" })).toThrow();
    expect(() =>
      parseSetAppTabActiveRequest({
        tabId: "tab",
        rendererId: 17,
        active: "yes",
        deckId: "deck-1",
        threadId: "thread-1",
      }),
    ).toThrow();
    expect(() => parseAppTabRendererRequest({ tabId: "tab", rendererId: NaN })).toThrow();
  });
});
