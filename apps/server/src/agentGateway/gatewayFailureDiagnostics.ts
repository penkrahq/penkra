import { startDiagnosticTrace } from "@penkra/shared/traceContext";

import { recordDiagnosticIncident } from "../diagnostics/recorder.ts";
import { mcpToolResultError } from "./protocol.ts";
import { errorText, ToolInputError } from "./toolInput.ts";
import { GatewayToolError } from "./toolRuntime.ts";

/** Record failures consumed by the MCP response boundary without storing error text. */
export function recordGatewayConsumedFailure(error: unknown): void {
  const rejected =
    error instanceof ToolInputError ||
    error instanceof GatewayToolError ||
    (error instanceof Error && error.name === "AgentGatewayTargetError");
  if (rejected) {
    recordDiagnosticIncident({
      ...startDiagnosticTrace(),
      kind: "command.rejected",
      code: "COMMAND_REJECTED",
      where: "agent.mcp_write",
      severity: "error",
      expected: { accepted: true },
      actual: { accepted: false },
      context: { source: "agent" },
    });
  } else {
    recordDiagnosticIncident({
      ...startDiagnosticTrace(),
      kind: "command.failed",
      code: "APP_OPERATION_FAILED",
      where: "agent.mcp_write",
      severity: "error",
      expected: { accepted: true },
      actual: { accepted: false },
      context: { source: "agent" },
    });
  }
}

export function gatewayMcpToolErrorResult(error: unknown) {
  recordGatewayConsumedFailure(error);
  return mcpToolResultError(errorText(error));
}
