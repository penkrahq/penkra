// FILE: transcriptOrderingDiagnostics.ts
// Purpose: Records content-safe evidence when durable message order needs presentation repair.
// Layer: Web chat diagnostics

export interface TranscriptOrderingDiagnosticMessage {
  readonly id: string;
  readonly role: string;
  readonly createdAt: string;
  readonly sequence?: number | undefined;
  readonly delivery?:
    | {
        readonly state: string;
        readonly queued: boolean;
        readonly sequence: number;
      }
    | undefined;
}

export interface TranscriptOrderingDiagnosticSample {
  readonly sequence: number;
  readonly recordedAt: string;
  readonly source: string;
  readonly before: readonly TranscriptOrderingDiagnosticEntry[];
  readonly after: readonly TranscriptOrderingDiagnosticEntry[];
}

interface TranscriptOrderingDiagnosticEntry {
  readonly id: string;
  readonly role: string;
  readonly admittedSequence: number | null;
  readonly presentationSequence: number | null;
  readonly deliveryState: string | null;
  readonly queued: boolean;
}

interface TranscriptOrderingDiagnosticState {
  nextSequence: number;
  samples: TranscriptOrderingDiagnosticSample[];
}

const MAX_SAMPLES = 200;

declare global {
  interface Window {
    __penkraTranscriptOrderingDiagnosticState?: TranscriptOrderingDiagnosticState;
    penkraTranscriptOrdering?: {
      samples: () => readonly TranscriptOrderingDiagnosticSample[];
      reset: () => void;
    };
  }
}

const state: TranscriptOrderingDiagnosticState =
  typeof window !== "undefined" && window.__penkraTranscriptOrderingDiagnosticState
    ? window.__penkraTranscriptOrderingDiagnosticState
    : { nextSequence: 1, samples: [] };

if (typeof window !== "undefined") {
  window.__penkraTranscriptOrderingDiagnosticState = state;
}

function presentationSequence(message: TranscriptOrderingDiagnosticMessage): number | null {
  return message.delivery?.queued === true && message.delivery.state !== "queued"
    ? message.delivery.sequence
    : (message.sequence ?? null);
}

function snapshot(message: TranscriptOrderingDiagnosticMessage): TranscriptOrderingDiagnosticEntry {
  return {
    id: message.id,
    role: message.role,
    admittedSequence: message.sequence ?? null,
    presentationSequence: presentationSequence(message),
    deliveryState: message.delivery?.state ?? null,
    queued: message.delivery?.queued ?? false,
  };
}

export function recordTranscriptOrderingRepair(
  source: string,
  before: readonly TranscriptOrderingDiagnosticMessage[],
  after: readonly TranscriptOrderingDiagnosticMessage[],
): void {
  if (!import.meta.env.DEV || typeof window === "undefined") return;
  const sample: TranscriptOrderingDiagnosticSample = {
    sequence: state.nextSequence,
    recordedAt: new Date().toISOString(),
    source,
    before: before.map(snapshot),
    after: after.map(snapshot),
  };
  state.nextSequence += 1;
  state.samples.push(sample);
  if (state.samples.length > MAX_SAMPLES) {
    state.samples.splice(0, state.samples.length - MAX_SAMPLES);
  }
}

export function getTranscriptOrderingDiagnosticSamples(): readonly TranscriptOrderingDiagnosticSample[] {
  return [...state.samples];
}

export function resetTranscriptOrderingDiagnostics(): void {
  state.samples.length = 0;
  state.nextSequence = 1;
}

if (typeof window !== "undefined" && import.meta.env.DEV) {
  window.penkraTranscriptOrdering = {
    samples: getTranscriptOrderingDiagnosticSamples,
    reset: resetTranscriptOrderingDiagnostics,
  };
}
