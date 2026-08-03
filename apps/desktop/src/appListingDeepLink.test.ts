import { describe, expect, it } from "vitest";

import { parseAppListingDeepLink } from "./appListingDeepLink";

describe("App listing deep links", () => {
  it("accepts exactly penkra://apps/<canonical-app-id>", () => {
    expect(parseAppListingDeepLink("penkra://apps/com.acme.canvas")).toEqual({
      appId: "com.acme.canvas",
    });
  });

  it.each([
    "https://apps/com.acme.canvas",
    "penkra://app/com.acme.canvas",
    "penkra://apps/not-a-uuid",
    "penkra://apps/com.acme.canvas/more",
    "penkra://apps/com.acme.canvas?tab=permissions",
  ])("rejects non-canonical input %s", (value) => {
    expect(parseAppListingDeepLink(value)).toBeNull();
  });
});
