import { describe, expect, it } from "vitest";

import { providerPermissionDecision } from "./providerPermissionPolicy.ts";

describe("provider permission policy", () => {
  it("declines restricted execution", () => {
    expect(providerPermissionDecision("approval-required")).toBe("decline");
  });
});
