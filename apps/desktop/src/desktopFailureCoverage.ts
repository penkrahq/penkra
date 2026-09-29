import type { IncidentInput } from "@penkra/shared/diagnostics/store";

type Incident = Omit<IncidentInput, "traceId" | "spanId">;
type Reporter = (incident: Incident) => void;

const STARTUP_PENDING_LIMIT = 64;
let reporter: Reporter | null = null;
const pending: Incident[] = [];

/** Main installs its durable diagnostics queue after desktop paths are resolved. */
export function installDesktopFailureCoverageReporter(next: Reporter): () => void {
  const previous = reporter;
  reporter = next;
  for (const incident of pending.splice(0)) recordDiagnosticIncident(incident);
  return () => {
    if (reporter === next) reporter = previous;
  };
}

function recordDiagnosticIncident(incident: Incident): void {
  if (reporter) {
    try {
      reporter(incident);
    } catch {
      process.stderr.write("[diagnostics] desktop incident forwarding failed\n");
    }
    return;
  }
  if (pending.length === STARTUP_PENDING_LIMIT) pending.shift();
  pending.push(incident);
}

/** Category is static, and no thrown value or user content enters this incident. */
export function recordDesktopConsumedFailure(
  category:
    | "app"
    | "tab"
    | "storage"
    | "registry"
    | "update"
    | "backend"
    | "platform"
    | "simulator",
): void {
  const common = {
    kind: "command.failed" as const,
    severity: "error" as const,
    actual: { outcome: "failed" as const },
  };
  switch (category) {
    case "app":
      recordDiagnosticIncident({
        ...common,
        code: "APP_OPERATION_FAILED",
        where: "desktop.app_runtime",
      });
      break;
    case "tab":
      recordDiagnosticIncident({
        ...common,
        code: "APP_OPERATION_FAILED",
        where: "desktop.tab_observer",
      });
      break;
    case "storage":
      recordDiagnosticIncident({
        ...common,
        code: "APP_OPERATION_FAILED",
        where: "desktop.app_storage",
      });
      break;
    case "registry":
      recordDiagnosticIncident({
        ...common,
        code: "APP_OPERATION_FAILED",
        where: "desktop.registry_client",
      });
      break;
    case "update":
      recordDiagnosticIncident({
        ...common,
        code: "APP_OPERATION_FAILED",
        where: "desktop.update_runtime",
      });
      break;
    case "backend":
      recordDiagnosticIncident({
        ...common,
        code: "APP_OPERATION_FAILED",
        where: "desktop.backend_runtime",
      });
      break;
    case "platform":
      recordDiagnosticIncident({
        ...common,
        code: "APP_OPERATION_FAILED",
        where: "desktop.platform_runtime",
      });
      break;
    case "simulator":
      recordDiagnosticIncident({
        ...common,
        code: "APP_OPERATION_FAILED",
        where: "desktop.simulator_runtime",
      });
      break;
  }
}
