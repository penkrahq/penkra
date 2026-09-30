import { describe, expect, it, vi } from "vitest";
import {
  validateDiagnosticFields,
  validateDiagnosticToken,
} from "@penkra/shared/diagnostics/privacy";

vi.mock("./recorder", () => ({ recordDiagnosticIncident: vi.fn() }));

import { recordDiagnosticIncident } from "./recorder";
import { recordCodexTransportFailure } from "./codexTransportFailure";

describe("Codex app-server transport diagnostics", () => {
  it("records a content-free incident for a handled transport failure", () => {
    recordCodexTransportFailure();
    const input = vi.mocked(recordDiagnosticIncident).mock.calls.at(-1)?.[0];
    expect(input).toEqual(
      expect.objectContaining({
        code: "EXTERNAL_CALL_FAILED",
        where: "server.codex_app_transport",
        expected: { accepted: true },
        actual: { accepted: false },
      }),
    );
    expect(validateDiagnosticFields(input?.expected ?? {})).toEqual({ accepted: true });
    expect(validateDiagnosticFields(input?.actual ?? {})).toEqual({ accepted: false });
    expect(validateDiagnosticToken(input?.where ?? "", "where")).toBe("server.codex_app_transport");
  });
});
