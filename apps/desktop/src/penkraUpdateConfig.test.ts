import { describe, expect, it } from "vitest";

import { bakedPenkraUpdateToken, penkraUpdateRequestHeaders } from "./penkraUpdateConfig";

describe("Penkra update configuration", () => {
  it("has no token in ordinary development and test bundles", () => {
    expect(bakedPenkraUpdateToken()).toBe("");
  });

  it("adds the exact backend gate header only for a non-empty baked token", () => {
    expect(penkraUpdateRequestHeaders(" update-secret ")).toEqual({
      "X-Penkra-Update-Token": "update-secret",
    });
    expect(penkraUpdateRequestHeaders("  ")).toEqual({});
  });
});
