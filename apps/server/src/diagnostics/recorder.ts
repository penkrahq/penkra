import type { CheckpointInput, DiagnosticContext, DiagnosticsStore, IncidentInput } from "./store";

let activeStore: DiagnosticsStore | null = null;

/** Startup installs the single server writer after version reset and spool import. */
export function installDiagnosticsStore(store: DiagnosticsStore): () => void {
  activeStore = store;
  return () => {
    if (activeStore === store) activeStore = null;
  };
}

export function recordDiagnosticCheckpoint(input: CheckpointInput): void {
  try {
    activeStore?.checkpoint(input);
  } catch {
    // A diagnostics failure must not prevent the command it was observing.
    process.stderr.write("[diagnostics] checkpoint write failed\n");
  }
}

export function recordDiagnosticIncident(input: IncidentInput): void {
  try {
    activeStore?.incident(input);
  } catch {
    process.stderr.write("[diagnostics] incident write failed\n");
  }
}

export function traceForDiagnosticCommand(commandId: string): DiagnosticContext | null {
  try {
    return activeStore?.traceForCommand(commandId) ?? null;
  } catch {
    return null;
  }
}
