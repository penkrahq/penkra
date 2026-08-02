import { describe, expect, it } from "vitest";

import { parseAppListingDeepLink } from "./appListingDeepLink";

describe("App listing deep links", () => {
  it("accepts exactly penkra://apps/<registry-app-id>", () => {
    expect(parseAppListingDeepLink("penkra://apps/00000000-0000-4000-8000-000000000123")).toEqual({
      appId: "00000000-0000-4000-8000-000000000123",
    });
  });

  it.each([
    "https://apps/00000000-0000-4000-8000-000000000123",
    "penkra://app/00000000-0000-4000-8000-000000000123",
    "penkra://apps/not-a-uuid",
    "penkra://apps/00000000-0000-4000-8000-000000000123/more",
    "penkra://apps/00000000-0000-4000-8000-000000000123?tab=permissions",
  ])("rejects non-canonical input %s", (value) => {
    expect(parseAppListingDeepLink(value)).toBeNull();
  });
});
