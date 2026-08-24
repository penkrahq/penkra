// FILE: chatScrollDiagnostics.ts
// Purpose: Captures opt-in development evidence for transcript end-scroll failures.
// Layer: Web chat diagnostics

interface ScrollGeometrySource {
  readonly scrollTop: number;
  readonly clientHeight: number;
  readonly scrollHeight: number;
}

interface VirtualItemSnapshot {
  readonly index: number;
  readonly start: number;
  readonly end: number;
  readonly size: number;
}

export interface TranscriptVirtualizerDiagnosticsSource {
  readonly scrollOffset?: number | null;
  readonly range?: { readonly startIndex: number; readonly endIndex: number } | null;
  getTotalSize?: () => number;
  getVirtualItems?: () => readonly VirtualItemSnapshot[];
  isAtEnd?: (threshold?: number) => boolean;
}

export interface ChatScrollDiagnosticSample {
  readonly sequence: number;
  readonly recordedAt: number;
  readonly instanceId: number;
  readonly event: string;
  readonly dataCount: number;
  readonly anchorRevision: string;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly dom: {
    readonly scrollTop: number;
    readonly clientHeight: number;
    readonly scrollHeight: number;
    readonly distanceFromEnd: number;
  } | null;
  readonly virtual: {
    readonly scrollOffset: number | null;
    readonly totalSize: number | null;
    readonly isAtEnd: boolean | null;
    readonly rangeStart: number | null;
    readonly rangeEnd: number | null;
    readonly renderedStart: number | null;
    readonly renderedEnd: number | null;
    readonly renderedCount: number;
  } | null;
}

interface RecordChatScrollDiagnosticInput {
  readonly instanceId: number;
  readonly event: string;
  readonly dataCount: number;
  readonly anchorRevision: string;
  readonly element?: ScrollGeometrySource | null;
  readonly virtualizer?: TranscriptVirtualizerDiagnosticsSource | null;
  readonly detail?: Readonly<Record<string, unknown>>;
}

const MAX_SAMPLES = 2_000;
const PERSISTED_ENABLE_KEY = "penkra:chat-scroll-diagnostics-enabled";
const state = {
  enabled: false,
  logToConsole: false,
  nextInstanceId: 1,
  nextSequence: 1,
  samples: [] as ChatScrollDiagnosticSample[],
};

function persistEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (enabled) {
      window.localStorage.setItem(PERSISTED_ENABLE_KEY, "true");
    } else {
      window.localStorage.removeItem(PERSISTED_ENABLE_KEY);
    }
  } catch {
    // Diagnostics must remain optional when storage is unavailable.
  }
}

function readPersistedEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(PERSISTED_ENABLE_KEY) === "true";
  } catch {
    return false;
  }
}

function diagnosticsAvailable(): boolean {
  return import.meta.env.DEV && typeof performance !== "undefined";
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readDomSnapshot(element: ScrollGeometrySource | null | undefined) {
  if (!element) return null;
  const scrollTop = finiteOrNull(element.scrollTop);
  const clientHeight = finiteOrNull(element.clientHeight);
  const scrollHeight = finiteOrNull(element.scrollHeight);
  if (scrollTop === null || clientHeight === null || scrollHeight === null) return null;
  return {
    scrollTop,
    clientHeight,
    scrollHeight,
    distanceFromEnd: Math.max(0, scrollHeight - clientHeight - scrollTop),
  };
}

function readVirtualSnapshot(
  virtualizer: TranscriptVirtualizerDiagnosticsSource | null | undefined,
) {
  if (!virtualizer) return null;
  let virtualItems: readonly VirtualItemSnapshot[] = [];
  let totalSize: number | null = null;
  try {
    virtualItems = virtualizer.getVirtualItems?.() ?? [];
    totalSize = finiteOrNull(virtualizer.getTotalSize?.());
  } catch {
    // Diagnostics must never affect chat behavior during a partial virtualizer update.
  }
  const first = virtualItems.at(0) ?? null;
  const last = virtualItems.at(-1) ?? null;
  let isAtEnd: boolean | null = null;
  try {
    isAtEnd = virtualizer.isAtEnd?.() ?? null;
  } catch {
    // Diagnostics must never affect chat behavior when a library method is unavailable.
  }
  return {
    scrollOffset: finiteOrNull(virtualizer.scrollOffset),
    totalSize,
    isAtEnd,
    rangeStart: finiteOrNull(virtualizer.range?.startIndex),
    rangeEnd: finiteOrNull(virtualizer.range?.endIndex),
    renderedStart: finiteOrNull(first?.index),
    renderedEnd: finiteOrNull(last?.index),
    renderedCount: virtualItems.length,
  };
}

export function nextChatScrollDiagnosticInstanceId(): number {
  const instanceId = state.nextInstanceId;
  state.nextInstanceId += 1;
  return instanceId;
}

export function areChatScrollDiagnosticsEnabled(): boolean {
  return state.enabled && diagnosticsAvailable();
}

export function recordChatScrollDiagnostic(input: RecordChatScrollDiagnosticInput): void {
  if (!state.enabled || !diagnosticsAvailable()) return;
  const sample: ChatScrollDiagnosticSample = {
    sequence: state.nextSequence,
    recordedAt: performance.now(),
    instanceId: input.instanceId,
    event: input.event,
    dataCount: input.dataCount,
    anchorRevision: input.anchorRevision,
    detail: input.detail ?? {},
    dom: readDomSnapshot(input.element),
    virtual: readVirtualSnapshot(input.virtualizer),
  };
  state.nextSequence += 1;
  state.samples.push(sample);
  if (state.samples.length > MAX_SAMPLES) {
    state.samples.splice(0, state.samples.length - MAX_SAMPLES);
  }
  if (state.logToConsole) {
    console.debug("[chat-scroll]", sample);
  }
}

export function enableChatScrollDiagnostics(options?: { logToConsole?: boolean }): void {
  if (!diagnosticsAvailable()) return;
  state.enabled = true;
  state.logToConsole = options?.logToConsole ?? false;
  persistEnabled(true);
}

export function disableChatScrollDiagnostics(): void {
  state.enabled = false;
  state.logToConsole = false;
  persistEnabled(false);
}

export function resetChatScrollDiagnostics(): void {
  state.nextSequence = 1;
  state.samples = [];
}

export function getChatScrollDiagnosticSamples(): readonly ChatScrollDiagnosticSample[] {
  return state.samples.map((sample) => ({
    ...sample,
    detail: { ...sample.detail },
    dom: sample.dom ? { ...sample.dom } : null,
    virtual: sample.virtual ? { ...sample.virtual } : null,
  }));
}

declare global {
  interface Window {
    penkraChatScroll?: {
      enable: typeof enableChatScrollDiagnostics;
      disable: typeof disableChatScrollDiagnostics;
      reset: typeof resetChatScrollDiagnostics;
      samples: typeof getChatScrollDiagnosticSamples;
    };
  }
}

if (import.meta.env.DEV && typeof window !== "undefined") {
  state.enabled = readPersistedEnabled();
  window.penkraChatScroll = {
    enable: enableChatScrollDiagnostics,
    disable: disableChatScrollDiagnostics,
    reset: resetChatScrollDiagnostics,
    samples: getChatScrollDiagnosticSamples,
  };
}
