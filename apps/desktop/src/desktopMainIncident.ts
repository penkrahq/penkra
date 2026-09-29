import type { IncidentInput } from "@penkra/shared/diagnostics/store";
import { startDiagnosticTrace } from "@penkra/shared/traceContext";

/** Add trace identity to an already content-free main-process incident. */
export function recordDesktopMainIncident(
  enqueue: (kind: "incident", input: IncidentInput) => void,
  input: Omit<IncidentInput, "traceId" | "spanId">,
): void {
  enqueue("incident", { ...startDiagnosticTrace(), ...input });
}
