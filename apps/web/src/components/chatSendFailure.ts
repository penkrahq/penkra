import type { DiagnosticTraceContext } from "@penkra/contracts";
import { startDiagnosticTrace } from "@penkra/shared/traceContext";

export function recordChatSendFailure(
  code: "SEND_PREFLIGHT_REJECTED" | "COMMAND_REJECTED" | "EXTERNAL_CALL_FAILED",
  trace: DiagnosticTraceContext = startDiagnosticTrace(),
): void {
  try {
    const pending = window.desktopBridge?.recordDiagnosticIncident?.({
      ...trace,
      kind: code === "COMMAND_REJECTED" ? "command.rejected" : "external.failed",
      code,
      where: "browser.send",
      severity: "error",
      expected: { accepted: true },
      actual: { accepted: false },
    });
    void pending?.catch(() => undefined);
  } catch {
    // Diagnostics cannot delay a send or change its result.
  }
}
