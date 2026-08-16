// FILE: chatPerformanceDiagnostics.tsx
// Purpose: Development-only measurements for composer input, React commits, and paint latency.
// Layer: Web chat diagnostics

import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from "react";

export type ChatPerformanceSurface = "composer" | "transcript";
export type ChatPerformanceWorkKind = "draft-checkpoint";

export interface ChatPerformanceWorkSample {
  readonly kind: ChatPerformanceWorkKind | "long-task";
  readonly startedAt: number;
  readonly durationMs: number;
}

export interface ChatPerformanceSample {
  readonly interactionId: number;
  readonly startedAt: number;
  readonly inputProcessingMs: number | null;
  readonly composerCommitMs: number | null;
  readonly inputToPaintMs: number | null;
  readonly transcriptCommitCount: number;
  readonly transcriptActualDurationMs: number;
  readonly transcriptChangedProps: readonly string[];
}

interface MutableChatPerformanceSample {
  interactionId: number;
  startedAt: number;
  inputProcessingMs: number | null;
  composerCommitMs: number | null;
  inputToPaintMs: number | null;
  transcriptCommitCount: number;
  transcriptActualDurationMs: number;
  transcriptChangedProps: string[];
}

const MAX_SAMPLES = 500;
const state = {
  enabled: false,
  logToConsole: false,
  nextInteractionId: 1,
  activeInteraction: null as MutableChatPerformanceSample | null,
  samples: [] as MutableChatPerformanceSample[],
  workSamples: [] as ChatPerformanceWorkSample[],
  longTaskObserver: null as PerformanceObserver | null,
};

function isDiagnosticsAvailable(): boolean {
  return import.meta.env.DEV && typeof performance !== "undefined";
}

function percentile(values: readonly number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index] ?? null;
}

function appendWorkSample(sample: ChatPerformanceWorkSample): void {
  state.workSamples.push(sample);
  if (state.workSamples.length > MAX_SAMPLES) {
    state.workSamples.splice(0, state.workSamples.length - MAX_SAMPLES);
  }
}

export function enableChatPerformanceDiagnostics(options?: { logToConsole?: boolean }): void {
  if (!isDiagnosticsAvailable()) return;
  state.enabled = true;
  state.logToConsole = options?.logToConsole ?? false;
  if (
    state.longTaskObserver === null &&
    typeof PerformanceObserver !== "undefined" &&
    PerformanceObserver.supportedEntryTypes.includes("longtask")
  ) {
    state.longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        appendWorkSample({
          kind: "long-task",
          startedAt: entry.startTime,
          durationMs: entry.duration,
        });
      }
    });
    state.longTaskObserver.observe({ entryTypes: ["longtask"] });
  }
}

export function disableChatPerformanceDiagnostics(): void {
  state.enabled = false;
  state.logToConsole = false;
  state.activeInteraction = null;
  state.longTaskObserver?.disconnect();
  state.longTaskObserver = null;
}

export function resetChatPerformanceDiagnostics(): void {
  state.activeInteraction = null;
  state.samples = [];
  state.workSamples = [];
  state.nextInteractionId = 1;
}

export function getChatPerformanceSamples(): readonly ChatPerformanceSample[] {
  return state.samples.map((sample) => ({ ...sample }));
}

export function getChatPerformanceWorkSamples(): readonly ChatPerformanceWorkSample[] {
  return state.workSamples.map((sample) => ({ ...sample }));
}

export function measureChatPerformanceWork<T>(kind: ChatPerformanceWorkKind, work: () => T): T {
  if (!state.enabled || !isDiagnosticsAvailable()) return work();
  const startedAt = performance.now();
  try {
    return work();
  } finally {
    appendWorkSample({
      kind,
      startedAt,
      durationMs: performance.now() - startedAt,
    });
  }
}

export function getChatPerformanceSummary(): {
  readonly enabled: boolean;
  readonly sampleCount: number;
  readonly inputToPaintP50Ms: number | null;
  readonly inputToPaintP95Ms: number | null;
  readonly inputProcessingP95Ms: number | null;
  readonly transcriptCommitCount: number;
  readonly draftCheckpointP95Ms: number | null;
  readonly longTaskCount: number;
} {
  const samples = getChatPerformanceSamples();
  const inputToPaint = samples.flatMap((sample) =>
    sample.inputToPaintMs === null ? [] : [sample.inputToPaintMs],
  );
  const inputProcessing = samples.flatMap((sample) =>
    sample.inputProcessingMs === null ? [] : [sample.inputProcessingMs],
  );
  const workSamples = getChatPerformanceWorkSamples();
  const draftCheckpoints = workSamples
    .filter((sample) => sample.kind === "draft-checkpoint")
    .map((sample) => sample.durationMs);
  return {
    enabled: state.enabled,
    sampleCount: samples.length,
    inputToPaintP50Ms: percentile(inputToPaint, 0.5),
    inputToPaintP95Ms: percentile(inputToPaint, 0.95),
    inputProcessingP95Ms: percentile(inputProcessing, 0.95),
    transcriptCommitCount: samples.reduce(
      (total, sample) => total + sample.transcriptCommitCount,
      0,
    ),
    draftCheckpointP95Ms: percentile(draftCheckpoints, 0.95),
    longTaskCount: workSamples.filter((sample) => sample.kind === "long-task").length,
  };
}

export function beginComposerInputMeasurement(): number | null {
  if (!state.enabled || !isDiagnosticsAvailable()) return null;
  const sample: MutableChatPerformanceSample = {
    interactionId: state.nextInteractionId,
    startedAt: performance.now(),
    inputProcessingMs: null,
    composerCommitMs: null,
    inputToPaintMs: null,
    transcriptCommitCount: 0,
    transcriptActualDurationMs: 0,
    transcriptChangedProps: [],
  };
  state.nextInteractionId += 1;
  state.activeInteraction = sample;
  state.samples.push(sample);
  if (state.samples.length > MAX_SAMPLES) {
    state.samples.splice(0, state.samples.length - MAX_SAMPLES);
  }
  return sample.interactionId;
}

export function recordChatTranscriptPropChanges(changedProps: readonly string[]): void {
  if (!state.enabled || changedProps.length === 0) return;
  const sample = state.activeInteraction;
  if (!sample) return;
  sample.transcriptChangedProps = Array.from(
    new Set([...sample.transcriptChangedProps, ...changedProps]),
  );
}

export function finishComposerInputProcessing(
  interactionId: number | null,
  startedAt: number,
): void {
  if (interactionId === null || !state.enabled) return;
  const sample = state.samples.find((entry) => entry.interactionId === interactionId);
  if (sample) sample.inputProcessingMs = performance.now() - startedAt;
}

export function recordChatPerformanceCommit(
  surface: ChatPerformanceSurface,
  actualDurationMs: number,
  commitTime: number,
): void {
  if (!state.enabled) return;
  const sample = state.activeInteraction;
  if (!sample) return;
  if (surface === "transcript") {
    // A Profiler boundary can commit because its parent recreated the wrapper
    // while the memoized transcript child did no work. Count only measured work.
    if (actualDurationMs < 0.05) return;
    sample.transcriptCommitCount += 1;
    sample.transcriptActualDurationMs += actualDurationMs;
    return;
  }
  sample.composerCommitMs ??= commitTime - sample.startedAt;
  requestAnimationFrame(() => {
    sample.inputToPaintMs ??= performance.now() - sample.startedAt;
    if (state.activeInteraction === sample) state.activeInteraction = null;
    if (state.logToConsole) {
      console.debug("[chat-performance] composer input", { ...sample });
    }
  });
}

const profilerCallbacks = new Map<ChatPerformanceSurface, ProfilerOnRenderCallback>();

function profilerCallback(surface: ChatPerformanceSurface): ProfilerOnRenderCallback {
  const existing = profilerCallbacks.get(surface);
  if (existing) return existing;
  const callback: ProfilerOnRenderCallback = (
    _id,
    _phase,
    actualDuration,
    _baseDuration,
    _startTime,
    commitTime,
  ) => recordChatPerformanceCommit(surface, actualDuration, commitTime);
  profilerCallbacks.set(surface, callback);
  return callback;
}

export function ChatPerformanceBoundary(props: {
  readonly surface: ChatPerformanceSurface;
  readonly children: ReactNode;
}) {
  if (!import.meta.env.DEV) return props.children;
  return (
    <Profiler id={`chat-${props.surface}`} onRender={profilerCallback(props.surface)}>
      {props.children}
    </Profiler>
  );
}

declare global {
  interface Window {
    penkraChatPerformance?: {
      enable: typeof enableChatPerformanceDiagnostics;
      disable: typeof disableChatPerformanceDiagnostics;
      reset: typeof resetChatPerformanceDiagnostics;
      samples: typeof getChatPerformanceSamples;
      work: typeof getChatPerformanceWorkSamples;
      summary: typeof getChatPerformanceSummary;
    };
  }
}

if (import.meta.env.DEV && typeof window !== "undefined") {
  window.penkraChatPerformance = {
    enable: enableChatPerformanceDiagnostics,
    disable: disableChatPerformanceDiagnostics,
    reset: resetChatPerformanceDiagnostics,
    samples: getChatPerformanceSamples,
    work: getChatPerformanceWorkSamples,
    summary: getChatPerformanceSummary,
  };
}
