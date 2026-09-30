import { describe, expect, it, vi } from "vitest";
import {
  validateDiagnosticFields,
  validateDiagnosticToken,
} from "@penkra/shared/diagnostics/privacy";

vi.mock("./recorder", () => ({ recordDiagnosticIncident: vi.fn() }));

import { recordDiagnosticIncident } from "./recorder";
import { recordCodexManagerFailure } from "./codexManagerFailure";

describe("Codex app-server manager diagnostics", () => {
  it("records a content-free provider failure", () => {
    recordCodexManagerFailure();
    const input = vi.mocked(recordDiagnosticIncident).mock.calls.at(-1)?.[0];
    expect(input).toEqual(
      expect.objectContaining({
        code: "EXTERNAL_CALL_FAILED",
        where: "server.codex_app",
        expected: { accepted: true },
        actual: { accepted: false },
      }),
    );
    expect(validateDiagnosticFields(input?.expected ?? {})).toEqual({ accepted: true });
    expect(validateDiagnosticFields(input?.actual ?? {})).toEqual({ accepted: false });
    expect(validateDiagnosticToken(input?.where ?? "", "where")).toBe("server.codex_app");
  });
});
