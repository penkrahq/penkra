import { describe, expect, it } from "vitest";

import { quotePosixShellArgument } from "./shellQuote";

describe("quotePosixShellArgument", () => {

  it("wraps tokens that contain shell metacharacters", () => {
    expect(quotePosixShellArgument("foo;rm -rf /")).toBe("'foo;rm -rf /'");
    expect(quotePosixShellArgument("a$(echo b)")).toBe("'a$(echo b)'");
    expect(quotePosixShellArgument("a&b|c")).toBe("'a&b|c'");
    expect(quotePosixShellArgument("a*b?c[d]")).toBe("'a*b?c[d]'");
  });

  it("escapes embedded single quotes using the close/escape/open idiom", () => {
    expect(quotePosixShellArgument("it's")).toBe(`'it'\\''s'`);
    expect(quotePosixShellArgument("a'b'c")).toBe(`'a'\\''b'\\''c'`);
  });
});
