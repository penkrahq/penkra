import { describe, expect, it } from "vitest";
import { validateDiagnosticFields } from "./privacy";

describe("diagnostic field privacy", () => {
  it("rejects unknown keys even when their value is null", () => {
    expect(() => validateDiagnosticFields({ message: null })).toThrow(
      "Diagnostic field message is not allowlisted",
    );
    expect(validateDiagnosticFields({ threadId: null })).toEqual({ threadId: null });
  });
});
