import { randomBytes } from "node:crypto";

import type {
  CheckpointInput,
  DiagnosticContext,
  DiagnosticsStore,
  ExpectationInput,
  ExternalOutcomeInput,
  IncidentInput,
  ProvenanceInput,
  ExpectationKind,
} from "./store";
import { DIAGNOSTIC_LIMITS } from "./limits";

let activeStore: DiagnosticsStore | null = null;
const EARLY_INCIDENT_CAPACITY = 256;
const EARLY_INCIDENT_DRAIN_BATCH = 8;
const earlyIncidents: IncidentInput[] = [];
let earlyIncidentOverflow = 0;

function drainEarlyIncidents(store: DiagnosticsStore): void {
  if (activeStore !== store) return;
  if (earlyIncidentOverflow > 0) {
    const count = earlyIncidentOverflow;
    try {
      store.incident({
        traceId: randomBytes(16).toString("hex"),
        spanId: randomBytes(8).toString("hex"),
        kind: "diagnostics.degraded",
        code: "DIAGNOSTICS_DROPPED",
        where: "diagnostics.write",
        severity: "error",
        expected: { count: 0 },
        actual: { count },
      });
      earlyIncidentOverflow = 0;
    } catch {
      // Keep the count for the next scheduled drain.
    }
  }
  for (let i = 0; i < EARLY_INCIDENT_DRAIN_BATCH && earlyIncidents.length > 0; i++) {
    const input = earlyIncidents.shift()!;
    try {
      store.incident(input);
    } catch {
      earlyIncidentOverflow += 1;
    }
  }
  if (earlyIncidents.length > 0) {
    setImmediate(() => drainEarlyIncidents(store));
  } else if (earlyIncidentOverflow > 0) {
    const retry = setTimeout(() => drainEarlyIncidents(store), DIAGNOSTIC_LIMITS.batchMs);
    retry.unref();
  }
}

/** Startup installs the single server writer after version reset and spool import. */
export function installDiagnosticsStore(store: DiagnosticsStore): () => void {
  activeStore = store;
  setImmediate(() => drainEarlyIncidents(store));
  const stopHealthSampling = store.startHealthSampling();
  const stopProcessWatchdog = store.startProcessWatchdog();
  const importTimer = setInterval(() => {
    try {
      store.importPeerSpools();
    } catch {
      process.stderr.write("[diagnostics] peer spool import failed\n");
    }
  }, DIAGNOSTIC_LIMITS.batchMs);
  importTimer.unref();
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
    clearInterval(importTimer);
    stopHealthSampling();
    stopProcessWatchdog();
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
    activeStore?.importPeerSpools();
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

export function recordDiagnosticExternalOutcome(input: ExternalOutcomeInput): void {
  try {
    activeStore?.externalOutcome(input);
  } catch {
    process.stderr.write("[diagnostics] external outcome write failed\n");
  }
}

export function recordDiagnosticIncident(input: IncidentInput): void {
  if (activeStore === null) {
    if (earlyIncidents.length === EARLY_INCIDENT_CAPACITY) {
      earlyIncidents.shift();
      earlyIncidentOverflow += 1;
    }
    earlyIncidents.push(input);
    return;
  }
  try {
    activeStore.incident(input);
  } catch {
    process.stderr.write("[diagnostics] incident write failed\n");
  }
}

export function recordDiagnosticProvenance(input: ProvenanceInput): void {
  try {
    activeStore?.setProvenance(input);
  } catch {
    process.stderr.write("[diagnostics] provenance write failed\n");
  }
}

export function traceForDiagnosticCommand(commandId: string): DiagnosticContext | null {
  try {
    return activeStore?.traceForCommand(commandId) ?? null;
  } catch {
    return null;
  }
}
