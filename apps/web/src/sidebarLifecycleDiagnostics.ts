// FILE: sidebarLifecycleDiagnostics.ts
// Purpose: Captures the shell inputs and derived status behind sidebar work chrome.
// Layer: Web sidebar diagnostics

export type SidebarDiagnosticWorkStatus = "idle" | "running" | "done" | "attention" | "recording";

export interface SidebarLifecycleDiagnosticState {
  readonly threadId: string;
  readonly summaryPresent: boolean;
  readonly activeSidebarThreadId: string | null;
  readonly draftPromotedTo: string | null;
  readonly hasLocalSendOwner: boolean;
  readonly projectedWorkStatus: string | null;
  readonly sessionStatus: string | null;
  readonly sessionOrchestrationStatus: string | null;
  readonly sessionUpdatedAt: string | null;
  readonly latestTurnId: string | null;
  readonly pendingTurnStartMessageId: string | null;
  readonly latestTurnState: string | null;
  readonly latestTurnRequestedAt: string | null;
  readonly latestTurnStartedAt: string | null;
  readonly latestTurnCompletedAt: string | null;
  readonly derivedStatusLabel: string | null;
  readonly derivedWorkStatus: SidebarDiagnosticWorkStatus;
}

export interface SidebarLifecycleDiagnosticSample extends SidebarLifecycleDiagnosticState {
  readonly event: "derived-state";
  readonly sequence: number;
  readonly recordedAt: string;
  readonly performanceNow: number;
}

const MAX_SAMPLES = 1_000;
interface SidebarLifecycleDiagnosticBuffer {
  nextSequence: number;
  logToConsole: boolean;
  samples: SidebarLifecycleDiagnosticSample[];
  lastSignatureByThreadId: Map<string, string>;
}

declare global {
  interface Window {
    __penkraSidebarLifecycleDiagnosticBuffer?: SidebarLifecycleDiagnosticBuffer;
  }
}

const state: SidebarLifecycleDiagnosticBuffer =
  typeof window !== "undefined" && window.__penkraSidebarLifecycleDiagnosticBuffer
    ? window.__penkraSidebarLifecycleDiagnosticBuffer
    : {
        nextSequence: 1,
        logToConsole: false,
        samples: [],
        lastSignatureByThreadId: new Map(),
      };

if (typeof window !== "undefined") window.__penkraSidebarLifecycleDiagnosticBuffer = state;

function diagnosticsAvailable(): boolean {
  return typeof performance !== "undefined";
}

export function recordSidebarLifecycleDiagnostic(input: SidebarLifecycleDiagnosticState): void {
  if (!diagnosticsAvailable()) return;
  const signature = JSON.stringify(input);
  if (state.lastSignatureByThreadId.get(input.threadId) === signature) return;
  state.lastSignatureByThreadId.set(input.threadId, signature);
  const sample: SidebarLifecycleDiagnosticSample = {
    event: "derived-state",
    sequence: state.nextSequence++,
    recordedAt: new Date().toISOString(),
    performanceNow: performance.now(),
    ...input,
  };
  state.samples.push(sample);
  if (state.samples.length > MAX_SAMPLES)
    state.samples.splice(0, state.samples.length - MAX_SAMPLES);
  if (state.logToConsole) console.debug("[sidebar-lifecycle]", sample);
}

export function getSidebarLifecycleDiagnosticSamples(
  threadId?: string,
): readonly SidebarLifecycleDiagnosticSample[] {
  return state.samples
    .filter((sample) => threadId === undefined || sample.threadId === threadId)
    .map((sample) => Object.assign({}, sample));
}

export function resetSidebarLifecycleDiagnostics(): void {
  state.nextSequence = 1;
  state.samples = [];
  state.lastSignatureByThreadId.clear();
}

export function setSidebarLifecycleConsoleLogging(enabled: boolean): void {
  state.logToConsole = enabled;
}

declare global {
  interface Window {
    penkraSidebarLifecycle?: {
      samples: typeof getSidebarLifecycleDiagnosticSamples;
      reset: typeof resetSidebarLifecycleDiagnostics;
      logToConsole: typeof setSidebarLifecycleConsoleLogging;
    };
  }
}

if (typeof window !== "undefined") {
  window.penkraSidebarLifecycle = {
    samples: getSidebarLifecycleDiagnosticSamples,
    reset: resetSidebarLifecycleDiagnostics,
    logToConsole: setSidebarLifecycleConsoleLogging,
  };
}
