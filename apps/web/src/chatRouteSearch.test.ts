import { describe, expect, it } from "vitest";

import { createStableChatRouteSearchSelector, parseChatRouteSearch } from "./chatRouteSearch";

describe("parseChatRouteSearch", () => {
  it("returns an empty search object when a route has no search state", () => {
    expect(parseChatRouteSearch(null)).toEqual({});
  });

  it("keeps a non-empty split view id", () => {
    expect(parseChatRouteSearch({ splitViewId: " split-1 " })).toEqual({
      splitViewId: "split-1",
    });
  });

  it("returns an object on the selector's first empty route", () => {
    const select = createStableChatRouteSearchSelector();

    const first = select(null);
    const second = select({});

    expect(first).toEqual({});
    expect(second).toBe(first);
  });
});
