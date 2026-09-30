import { startDiagnosticTrace } from "@penkra/shared/traceContext";

import { recordDiagnosticIncident } from "../diagnostics/recorder.ts";

export function recordGatewayCreateFailure(threadId: string, retainedThread: boolean): void {
  recordDiagnosticIncident({
    ...startDiagnosticTrace(),
    ...(retainedThread ? { threadId } : {}),
    kind: "command.failed",
    code: "APP_OPERATION_FAILED",
    where: "agent.mcp_write",
    severity: "error",
    expected: { accepted: true },
    actual: { accepted: false },
    context: { source: "agent" },
  });
}
