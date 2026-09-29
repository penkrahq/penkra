import type { IncidentInput } from "@penkra/shared/diagnostics/store";

type Incident = Omit<IncidentInput, "traceId" | "spanId">;

/** Preserve the IPC rejection while recording a content-free boundary incident. */
export function wrapDesktopIpcHandler<Args extends unknown[], Result>(
  listener: (...args: Args) => Result | Promise<Result>,
  recordDiagnosticIncident: (incident: Incident) => void,
): (...args: Args) => Promise<Result> {
  return async (...args) => {
    try {
      return await listener(...args);
    } catch (error) {
      try {
        recordDiagnosticIncident({
          kind: "command.failed",
          code: "APP_OPERATION_FAILED",
          where: "desktop.ipc_dispatch",
          severity: "error",
          actual: { outcome: "failed" },
        });
      } catch {
        process.stderr.write("[diagnostics] desktop IPC incident forwarding failed\n");
      }
      throw error;
    }
  };
}
