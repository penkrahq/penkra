import type { DiagnosticContext } from "../diagnostics/store";
import { startDiagnosticTrace } from "@penkra/shared/traceContext";
import type { AgentGatewayCapability } from "./Services/AgentGatewaySessionRegistry";
import { recordDiagnosticCheckpoint, recordDiagnosticIncident } from "../diagnostics/recorder";

export type McpAuthorityCheck =
  | "ingress_write_authority_missing"
  | "caller_thread_lookup_failed"
  | "active_execution_lookup_failed"
  | "authorized_turn_no_longer_active";

export function recordMcpAuthorityRejected(input: {
  readonly trace: DiagnosticContext;
  readonly threadId: string;
  readonly arrivedTurnId: string | null;
  readonly expectedTurnId: string | null;
  readonly observedTurnId: string | null;
  readonly failedCheck: McpAuthorityCheck;
}): void {
  const context = {
    ...input.trace,
    threadId: input.threadId,
    ...(input.arrivedTurnId ? { turnId: input.arrivedTurnId } : {}),
  };
  recordDiagnosticCheckpoint({
    ...context,
    flow: "mcp_write",
    step: "mcp.authority_rejected",
    outcome: "rejected",
  });
  recordDiagnosticIncident({
    ...context,
    kind: "command.rejected",
    code: "CALLER_TURN_INACTIVE",
    where: "agent.mcp_write",
    severity: "error",
    expected: { accepted: true },
    actual: {
      accepted: false,
      ...(input.observedTurnId ? { activeTurnId: input.observedTurnId } : {}),
      ...(input.expectedTurnId ? { callerTurnId: input.expectedTurnId } : {}),
    },
    context: { mcpCheck: input.failedCheck },
    lastCheckpoint: "mcp.authority_rejected",
  });
}

export function recordMcpScopeDenied(input: {
  readonly trace?: DiagnosticContext | undefined;
  readonly threadId: string;
  readonly turnId: string | null;
  readonly capability: AgentGatewayCapability;
}): void {
  recordDiagnosticIncident({
    ...(input.trace ?? startDiagnosticTrace()),
    threadId: input.threadId,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    kind: "command.rejected",
    code: "SCOPE_DENIED",
    where: "agent.mcp_write",
    severity: "error",
    expected: { accepted: true },
    actual: { accepted: false },
    context: { capability: input.capability },
  });
}
