import { describe, expect, it } from "vitest";

import { providerPermissionDecision } from "./providerPermissionPolicy.ts";

describe("provider permission policy", () => {
  it("accepts full-access execution", () => {
    expect(providerPermissionDecision("full-access")).toBe("accept");
  });
  it("declines restricted execution", () => {
    expect(providerPermissionDecision("approval-required")).toBe("decline");
  });
});
