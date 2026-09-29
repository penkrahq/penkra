import { preStoreBootStageForExitCode } from "@penkra/shared/diagnostics/startupExit";
import type { IncidentInput } from "@penkra/shared/diagnostics/store";

type DesktopIncident = Omit<IncidentInput, "traceId" | "spanId">;

/** One recorder belongs to one spawned backend and observes its readiness and exit. */
export function createBackendStartupIncidentRecorder(record: (incident: DesktopIncident) => void): {
  markReady(): void;
  recordExit(code: number | null): void;
} {
  let ready = false;
  let recorded = false;
  return {
    markReady(): void {
      ready = true;
    },
    recordExit(code): void {
      if (ready || recorded || code === null) return;
      const bootStage = preStoreBootStageForExitCode(code);
      if (!bootStage) return;
      recorded = true;
      record({
        kind: "process.crashed",
        code: "BACKEND_STARTUP_FAILED",
        where: "desktop.backend_start",
        severity: "error",
        expected: { accepted: true },
        actual: { accepted: false, exitCode: code },
        context: { bootStage },
      });
    },
  };
}
