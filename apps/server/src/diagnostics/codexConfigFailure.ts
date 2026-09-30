import { startDiagnosticTrace } from "@penkra/shared/traceContext";

import { recordDiagnosticIncident } from "./recorder";

export function recordCodexConfigFailure(): void {
  recordDiagnosticIncident({
    ...startDiagnosticTrace(),
    kind: "external.failed",
    code: "EXTERNAL_CALL_FAILED",
    where: "server.codex_config",
    severity: "error",
    expected: { accepted: true },
    actual: { accepted: false },
  });
}
