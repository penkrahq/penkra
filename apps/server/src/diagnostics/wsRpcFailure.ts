import type { DiagnosticTraceContext } from "@penkra/contracts";
import { startDiagnosticTrace } from "@penkra/shared/traceContext";
import { recordDiagnosticIncident } from "./recorder";

/** Fixed fields keep RPC auxiliary failures out of diagnostic content storage. */
export function recordWsRpcFailure(
  trace: DiagnosticTraceContext = startDiagnosticTrace(),
  code: "EXTERNAL_CALL_FAILED" | "DIAGNOSTICS_WRITE_FAILED" = "EXTERNAL_CALL_FAILED",
): void {
  recordDiagnosticIncident({
    ...trace,
    kind: code === "DIAGNOSTICS_WRITE_FAILED" ? "diagnostics.degraded" : "external.failed",
    code,
    where: "server.ws_rpc",
    severity: "error",
    expected: { accepted: true },
    actual: { accepted: false },
  });
}
