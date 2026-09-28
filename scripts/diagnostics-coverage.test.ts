import { describe, expect, it } from "vitest";

import { COVERAGE_ROOTS, scanFailureSites } from "./diagnostics-coverage";

describe("diagnostics failure inventory", () => {
  it("visits all four production roots", () => {
    expect(COVERAGE_ROOTS).toEqual([
      "apps/server/src",
      "apps/web/src",
      "apps/desktop/src",
      "packages/shared/src",
    ]);
  });

  it("finds catches, throws, rejected effects and timeouts by syntax", () => {
    const source = `
      try { throw new Error("failed") } catch (cause) { Effect.catch(handle) }
      Effect.fail("failed"); Effect.die("failed"); Promise.reject("failed");
      Effect.timeout(task, 1000); setTimeout(done, 1000);
      const text = "throw new Error and setTimeout(";
    `;
    expect(scanFailureSites("apps/server/src/example.ts", source).map((site) => site.kind)).toEqual(
      ["throw", "catch", "catch", "rejection", "rejection", "rejection", "timeout", "timeout"],
    );
  });
});
