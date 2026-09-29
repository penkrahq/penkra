import { describe, expect, it, vi } from "vitest";
import {
  validateDiagnosticFields,
  validateDiagnosticToken,
} from "@penkra/shared/diagnostics/privacy";

vi.mock("./recorder", () => ({ recordDiagnosticIncident: vi.fn() }));

import { recordDiagnosticIncident } from "./recorder";
import { recordHttpFailure } from "./httpFailure";

describe("HTTP failure diagnostics", () => {
  it("uses a fixed content-free incident for a server error", () => {
    recordHttpFailure();
    const input = vi.mocked(recordDiagnosticIncident).mock.calls.at(-1)?.[0];
    expect(input).toEqual(
      expect.objectContaining({
        code: "EXTERNAL_CALL_FAILED",
        where: "server.http",
        expected: { accepted: true },
        actual: { accepted: false },
      }),
    );
    expect(validateDiagnosticFields(input?.expected ?? {})).toEqual({ accepted: true });
    expect(validateDiagnosticFields(input?.actual ?? {})).toEqual({ accepted: false });
    expect(validateDiagnosticToken(input?.where ?? "", "where")).toBe("server.http");
  });
});
