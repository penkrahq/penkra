import { describe, expect, it } from "vitest";
import { sanitizeDiagnosticValue } from "./diagnosticSanitizer.ts";

describe("diagnostic sanitizer", () => {
  it("redacts sensitive keys and secrets embedded in strings", () => {
    expect(
      sanitizeDiagnosticValue({
        authorization: "Bearer abcdefghijklmnop",
        command: "tool --api-key topsecret sk-abcdefghijk",
        nested: { token: "do-not-return", safe: "visible" },
      }),
    ).toEqual({
      authorization: "[redacted]",
      command: "tool --api-key [redacted] [redacted]",
      nested: { token: "[redacted]", safe: "visible" },
    });
  });

  it("redacts URL credentials and sensitive query parameters", () => {
    expect(
      sanitizeDiagnosticValue({
        callback:
          "https://user:password@example.test/callback?token=supersecret&api_key=alsosecret&safe=visible",
        header: "Authorization: Basic abcdef Cookie=session-secret",
      }),
    ).toEqual({
      callback:
        "https://[redacted]@example.test/callback?token=[redacted]&api_key=[redacted]&safe=visible",
      header: "Authorization: [redacted] Cookie=[redacted]",
    });
  });
});
