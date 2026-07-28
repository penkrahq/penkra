import { describe, expect, it } from "vitest";
import { markdownVisibleText } from "./markdownVisibleText";

describe("markdownVisibleText", () => {
  it("indexes rendered text rather than markdown punctuation", () => {
    expect(
      markdownVisibleText(
        "# Result\n\nUse **fast search** with [`findInPage`](https://electronjs.org).\n\n| A | B |\n| - | - |\n| one | two |",
      ),
    ).toBe("Result\nUse fast search with findInPage.\nA B\none two");
  });
});
