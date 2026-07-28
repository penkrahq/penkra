import { describe, expect, it } from "vitest";
import { assertDeveloperIdApplicationSignature } from "./mac-update-zip-finalize.ts";

describe("mac update zip signing identity", () => {
  it("rejects development-signed release applications", () => {
    expect(() =>
      assertDeveloperIdApplicationSignature(
        "Authority=Apple Development: Developer Name (ABCDE12345)",
      ),
    ).toThrow("must use Developer ID Application");
  });

  it("accepts Developer ID Application release applications", () => {
    expect(() =>
      assertDeveloperIdApplicationSignature(
        "Authority=Developer ID Application: Penkra, Inc. (D239U9W6M6)",
      ),
    ).not.toThrow();
  });
});
