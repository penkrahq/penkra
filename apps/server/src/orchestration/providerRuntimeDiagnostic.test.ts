import { describe, expect, it } from "vitest";

import { normalizeProviderRuntimeDiagnostic } from "./providerRuntimeDiagnostic.ts";

describe("normalizeProviderRuntimeDiagnostic", () => {
  it("preserves typed Codex identity, provenance, details, and explicit retry state", () => {
    expect(
      normalizeProviderRuntimeDiagnostic("codex", {
        error: {
          codexErrorInfo: "usageLimitExceeded",
          additionalDetails: "Provider-supplied diagnostic text.",
          request: { authorization: "not canonical" },
        },
        willRetry: false,
      }),
    ).toEqual({
      code: "usageLimitExceeded",
      codeSource: "error.codexErrorInfo",
      additionalDetails: "Provider-supplied diagnostic text.",
      willRetry: false,
    });
  });

  it("preserves an explicit retry warning without classifying its prose", () => {
    expect(normalizeProviderRuntimeDiagnostic("codex", { willRetry: true })).toEqual({
      willRetry: true,
    });
  });

  it("leaves a generic error without explicit machine facts unclassified", () => {
    expect(
      normalizeProviderRuntimeDiagnostic("codex", { error: { message: "request failed" } }),
    ).toBeUndefined();
  });

  it.each([undefined, null, "error", [], { willRetry: "false" }, { unknown: "value" }])(
    "omits unknown or malformed diagnostic input %#",
    (detail) => {
      expect(normalizeProviderRuntimeDiagnostic("codex", detail)).toBeUndefined();
    },
  );

  it("does not attribute a Codex code to another provider", () => {
    expect(
      normalizeProviderRuntimeDiagnostic("opencode", {
        error: { codexErrorInfo: "usageLimitExceeded" },
      }),
    ).toBeUndefined();
  });

  it("never truncates machine identity and marks shortened diagnostic text", () => {
    const diagnostic = normalizeProviderRuntimeDiagnostic("codex", {
      error: { codexErrorInfo: "c".repeat(300), additionalDetails: "d".repeat(900) },
    });
    expect(diagnostic?.code).toBeUndefined();
    expect(diagnostic?.codeSource).toBeUndefined();
    expect(diagnostic?.additionalDetailsTruncated).toBe(true);
    expect(diagnostic?.additionalDetails).toHaveLength(500);
  });
});
