// FILE: chatLifecycleDiagnostics.ts
// Purpose: Captures the exact renderer inputs behind transcript working chrome.
// Layer: Web chat diagnostics

export interface ChatLifecycleDiagnosticState {
  readonly threadId: string;
  readonly threadWorkStatus: string | null;
  readonly sessionStatus: string | null;
  readonly sessionUpdatedAt: string | null;
  readonly threadUpdatedAt: string | null;
  readonly orchestrationStatus: string | null;
  readonly activeTurnId: string | null;
  readonly latestTurnId: string | null;
  readonly latestTurnState: string | null;
  readonly latestTurnStartedAt: string | null;
  readonly latestTurnCompletedAt: string | null;
  readonly pendingTurnStartMessageId: string | null;
  readonly phase: string;
  readonly hasLiveTurnTail: boolean;
  readonly latestTurnSettledByProvider: boolean;
  readonly latestTurnSettled: boolean;
  readonly latestTurnLive: boolean;
  readonly hasLiveTurn: boolean;
  readonly isSendBusy: boolean;
  readonly hasPendingTurnStart: boolean;
  readonly isConnecting: boolean;
  readonly isEditingMessageHistory: boolean;
  readonly isTurnWorking: boolean;
  readonly isWorking: boolean;
  readonly showThinking: boolean;
  readonly activeWorkStartedAt: string | null;
  readonly streamingAssistantMessageCount: number;
  readonly latestMessageId: string | null;
  readonly latestMessageRole: string | null;
  readonly latestMessageCreatedAt: string | null;
  readonly latestMessageStreaming: boolean;
}

export interface ChatLifecycleDiagnosticSample extends ChatLifecycleDiagnosticState {
  readonly event: "derived-state";
  readonly sequence: number;
  readonly recordedAt: string;
  readonly performanceNow: number;
}

export type ChatLifecycleUiEvent =
  | "thinking-row-derived-visible"
  | "thinking-row-derived-hidden"
  | "working-timer-derived-visible"
  | "working-timer-derived-hidden";

export interface ChatLifecycleUiDiagnosticSample {
  readonly event: ChatLifecycleUiEvent;
  readonly sequence: number;
  readonly recordedAt: string;
  readonly performanceNow: number;
  readonly threadId: string;
  readonly activeTurnId: string | null;
  readonly activeTurnStartedAt: string | null;
  readonly isWorking: boolean;
}

export type ChatLifecycleSample = ChatLifecycleDiagnosticSample | ChatLifecycleUiDiagnosticSample;

const MAX_SAMPLES = 1_000;
interface ChatLifecycleDiagnosticBuffer {
  nextSequence: number;
  logToConsole: boolean;
  samples: ChatLifecycleSample[];
  lastSignatureByThreadId: Map<string, string>;
}

declare global {
  interface Window {
    __penkraChatLifecycleDiagnosticBuffer?: ChatLifecycleDiagnosticBuffer;
  }
}

const state: ChatLifecycleDiagnosticBuffer =
  typeof window !== "undefined" && window.__penkraChatLifecycleDiagnosticBuffer
    ? window.__penkraChatLifecycleDiagnosticBuffer
    : {
        nextSequence: 1,
        logToConsole: true,
        samples: [],
        lastSignatureByThreadId: new Map<string, string>(),
      };

// Samples recorded by the first hot-loaded instrumentation build predate the
// explicit event discriminator. Preserve that evidence and label it instead of
// clearing the buffer during the very transition we are trying to diagnose.
for (const sample of state.samples) {
  if (!("event" in sample)) {
    Object.assign(sample, { event: "derived-state" as const });
  }
}

if (typeof window !== "undefined") {
  // Keep the trace across Vite hot updates. That boundary is particularly
  // important for lifecycle bugs because adding instrumentation must not erase
  // the transition that motivated it.
  window.__penkraChatLifecycleDiagnosticBuffer = state;
}

function appendSample(sample: ChatLifecycleSample): void {
  state.samples.push(sample);
  if (state.samples.length > MAX_SAMPLES) {
    state.samples.splice(0, state.samples.length - MAX_SAMPLES);
  }
  if (state.logToConsole) {
    console.debug("[chat-lifecycle]", sample);
  }
}

function diagnosticsAvailable(): boolean {
  return import.meta.env.DEV && typeof performance !== "undefined";
}

export function recordChatLifecycleDiagnostic(input: ChatLifecycleDiagnosticState): void {
  if (!diagnosticsAvailable()) return;
  const signature = JSON.stringify(input);
  if (state.lastSignatureByThreadId.get(input.threadId) === signature) return;
  state.lastSignatureByThreadId.set(input.threadId, signature);

  const sample: ChatLifecycleDiagnosticSample = {
    event: "derived-state",
    sequence: state.nextSequence,
    recordedAt: new Date().toISOString(),
    performanceNow: performance.now(),
    ...input,
  };
  state.nextSequence += 1;
  appendSample(sample);
}

export function recordChatLifecycleUiDiagnostic(
  input: Omit<ChatLifecycleUiDiagnosticSample, "sequence" | "recordedAt" | "performanceNow">,
): void {
  if (!diagnosticsAvailable()) return;
  const sample: ChatLifecycleUiDiagnosticSample = {
    ...input,
    sequence: state.nextSequence,
    recordedAt: new Date().toISOString(),
    performanceNow: performance.now(),
  };
  state.nextSequence += 1;
  appendSample(sample);
}

export function getChatLifecycleDiagnosticSamples(
  threadId?: string,
): readonly ChatLifecycleSample[] {
  return state.samples
    .filter((sample) => threadId === undefined || sample.threadId === threadId)
    .map((sample) => ({ ...sample }));
}

export function resetChatLifecycleDiagnostics(): void {
  state.nextSequence = 1;
  state.samples = [];
  state.lastSignatureByThreadId.clear();
}

export function setChatLifecycleConsoleLogging(enabled: boolean): void {
  state.logToConsole = enabled;
}

declare global {
  interface Window {
    penkraChatLifecycle?: {
      samples: typeof getChatLifecycleDiagnosticSamples;
      reset: typeof resetChatLifecycleDiagnostics;
      logToConsole: typeof setChatLifecycleConsoleLogging;
    };
  }
}

if (import.meta.env.DEV && typeof window !== "undefined") {
  window.penkraChatLifecycle = {
    samples: getChatLifecycleDiagnosticSamples,
    reset: resetChatLifecycleDiagnostics,
    logToConsole: setChatLifecycleConsoleLogging,
  };
}
