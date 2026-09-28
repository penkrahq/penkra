import type {
  CheckpointInput,
  DiagnosticContext,
  DiagnosticsStore,
  ExpectationInput,
  IncidentInput,
  ExpectationKind,
} from "./store";

let activeStore: DiagnosticsStore | null = null;

/** Startup installs the single server writer after version reset and spool import. */
export function installDiagnosticsStore(store: DiagnosticsStore): () => void {
  activeStore = store;
  const stopHealthSampling = store.startHealthSampling();
  const sweep = setInterval(() => {
    try {
      store.sweepExpectations();
    } catch {
      process.stderr.write("[diagnostics] expectation sweep failed\n");
    }
  }, 1_000);
  sweep.unref();
  return () => {
    clearInterval(sweep);
    stopHealthSampling();
    if (activeStore === store) activeStore = null;
  };
}

export function armDiagnosticExpectation(input: ExpectationInput): string | null {
  try {
    return activeStore?.armExpectation(input) ?? null;
  } catch {
    process.stderr.write("[diagnostics] expectation arm failed\n");
    return null;
  }
}

export function resolveDiagnosticExpectation(
  id: string | null,
  outcome: "met" | "cancelled" = "met",
): void {
  if (id === null) return;
  try {
    activeStore?.resolveExpectation(id, outcome);
  } catch {
    process.stderr.write("[diagnostics] expectation resolution failed\n");
  }
}

export function resolveDiagnosticExpectationsForTrace(
  traceId: string,
  kind: ExpectationKind,
): void {
  try {
    activeStore?.resolveExpectationsForTrace(traceId, kind);
  } catch {
    process.stderr.write("[diagnostics] trace expectation resolution failed\n");
  }
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
