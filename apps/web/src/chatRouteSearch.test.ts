import { describe, expect, it } from "vitest";

import { parseChatRouteSearch } from "./chatRouteSearch";

describe("parseChatRouteSearch", () => {
  it("returns an empty search object when a route has no search state", () => {
    expect(parseChatRouteSearch(null)).toEqual({});
  });

  it("ignores a legacy split view URL", () => {
    expect(parseChatRouteSearch({ splitViewId: "split-1" })).toEqual({});
  });
});
