import { describe, expect, it, vi } from "vitest";
import {
  validateDiagnosticFields,
  validateDiagnosticToken,
} from "@penkra/shared/diagnostics/privacy";

vi.mock("./recorder", () => ({ recordDiagnosticIncident: vi.fn() }));

import { recordDiagnosticIncident } from "./recorder";
import { recordWsRpcFailure } from "./wsRpcFailure";

describe("auxiliary WebSocket RPC failures", () => {
  it("records only allowlisted fields on the original trace", () => {
    const trace = { traceId: "ab".repeat(16), spanId: "cd".repeat(8) };
    recordWsRpcFailure(trace);
    expect(recordDiagnosticIncident).toHaveBeenCalledWith({
      ...trace,
      kind: "external.failed",
      code: "EXTERNAL_CALL_FAILED",
      where: "server.ws_rpc",
      severity: "error",
      expected: { accepted: true },
      actual: { accepted: false },
    });
    const input = vi.mocked(recordDiagnosticIncident).mock.calls.at(-1)?.[0];
    expect(validateDiagnosticFields(input?.expected ?? {})).toEqual({ accepted: true });
    expect(validateDiagnosticFields(input?.actual ?? {})).toEqual({ accepted: false });
    expect(validateDiagnosticToken(input?.where ?? "", "where")).toBe("server.ws_rpc");
  });

  it("uses the degraded code for a failed legacy diagnostic write", () => {
    recordWsRpcFailure(undefined, "DIAGNOSTICS_WRITE_FAILED");
    expect(recordDiagnosticIncident).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "diagnostics.degraded",
        code: "DIAGNOSTICS_WRITE_FAILED",
        where: "server.ws_rpc",
      }),
    );
  });
});
