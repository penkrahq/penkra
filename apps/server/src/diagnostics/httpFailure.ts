import { startDiagnosticTrace } from "@penkra/shared/traceContext";
import { recordDiagnosticIncident } from "./recorder";

export function recordHttpFailure(): void {
  recordDiagnosticIncident({
    ...startDiagnosticTrace(),
    kind: "external.failed",
    code: "EXTERNAL_CALL_FAILED",
    where: "server.http",
    severity: "error",
    expected: { accepted: true },
    actual: { accepted: false },
  });
}
