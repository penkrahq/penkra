import { describe, expect, it } from "vitest";
import { methodsFromCodexSource } from "./codexRequestCoverage.ts";

describe("Codex native request coverage", () => {
  it("extracts calls rather than comments, diagnostics or a hand-maintained list", () => {
    expect(
      methodsFromCodexSource(
        "fixture.ts",
        `
      // request("not-a-request", {});
      this.sendRequest(transport, thread, "new/native/method", {});
      request("account/read", {});
      this.sendRequest(transport, thread, "account/read", {});
      log.info("unrelated/method");
    `,
      ),
    ).toEqual(["account/read", "new/native/method"]);
  });
  it("fails closed when a new call cannot be enumerated statically", () => {
    expect(() =>
      methodsFromCodexSource(
        "fixture.ts",
        `this.sendRequest(transport, thread, dynamicallyChosenMethod, {});`,
      ),
    ).toThrow("native method is not a literal");
  });
});
