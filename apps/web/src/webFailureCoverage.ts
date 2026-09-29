import { startDiagnosticTrace } from "@penkra/shared/traceContext";
import type { IncidentInput } from "@penkra/shared/diagnostics/store";

type WebIncident = Omit<IncidentInput, "traceId" | "spanId">;

function recordDiagnosticIncident(input: WebIncident): void {
  try {
    const pending = window.desktopBridge?.recordDiagnosticIncident?.({
      ...startDiagnosticTrace(),
      ...input,
    });
    void pending?.catch(() => undefined);
  } catch {
    // Diagnostics cannot change the browser operation's result.
  }
}

/** Record a fixed browser failure category without including user state or an exception. */
export function recordWebConsumedFailure(category: "state" | "runtime"): void {
  const common = {
    kind: "command.failed",
    severity: "error",
    expected: { accepted: true },
    actual: { accepted: false },
  } as const;
  switch (category) {
    case "state":
      recordDiagnosticIncident({
        ...common,
        code: "APP_OPERATION_FAILED",
        where: "browser.local_state",
      });
      break;
    case "runtime":
      recordDiagnosticIncident({
        ...common,
        code: "APP_OPERATION_FAILED",
        where: "browser.client_runtime",
      });
      break;
  }
}
