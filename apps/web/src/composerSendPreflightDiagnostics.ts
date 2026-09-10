export type ComposerSendPreflightDiagnosticEvent =
  | "claim"
  | "projection-published"
  | "dispatching"
  | "admission-retained"
  | "applied-frontier-settled"
  | "released"
  | "recovery-settled";

export interface ComposerSendPreflightDiagnosticSample {
  readonly event: ComposerSendPreflightDiagnosticEvent;
  readonly threadId: string;
  readonly ownerId: string;
  readonly messageId: string | null;
  readonly receiptSequence: number | null;
  readonly appliedSequence: number | null;
  readonly recordedAt: string;
  readonly performanceNow: number | null;
}

const MAX_SAMPLES = 512;
declare global {
  interface Window {
    __penkraComposerSendLifecycleSamples?: ComposerSendPreflightDiagnosticSample[];
    penkraComposerSendLifecycle?: {
      samples: typeof getComposerSendPreflightDiagnosticSamples;
      reset: typeof resetComposerSendPreflightDiagnostics;
    };
  }
}

const samples =
  typeof window !== "undefined" ? (window.__penkraComposerSendLifecycleSamples ??= []) : [];

export function recordComposerSendPreflightDiagnostic(
  input: Omit<ComposerSendPreflightDiagnosticSample, "recordedAt" | "performanceNow">,
): void {
  samples.push({
    ...input,
    recordedAt: new Date().toISOString(),
    performanceNow: typeof performance === "undefined" ? null : performance.now(),
  });
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
}

export function getComposerSendPreflightDiagnosticSamples(
  threadId?: string,
): readonly ComposerSendPreflightDiagnosticSample[] {
  return samples
    .filter((sample) => threadId === undefined || sample.threadId === threadId)
    .map((sample) => ({ ...sample }));
}

export function resetComposerSendPreflightDiagnostics(): void {
  samples.length = 0;
}

if (typeof window !== "undefined") {
  window.penkraComposerSendLifecycle = {
    samples: getComposerSendPreflightDiagnosticSamples,
    reset: resetComposerSendPreflightDiagnostics,
  };
}
