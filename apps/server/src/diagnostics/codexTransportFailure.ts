import { startDiagnosticTrace } from "@penkra/shared/traceContext";

import { recordDiagnosticIncident } from "./recorder";

export function recordCodexTransportFailure(): void {
  recordDiagnosticIncident({
    ...startDiagnosticTrace(),
    kind: "external.failed",
    code: "EXTERNAL_CALL_FAILED",
    where: "server.codex_app_transport",
    severity: "error",
    expected: { accepted: true },
    actual: { accepted: false },
  });
}
