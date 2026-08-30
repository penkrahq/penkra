// FILE: chatScrollDiagnostics.ts
// Purpose: Captures bounded, opt-in evidence for transcript end-scroll failures.
// Layer: Web chat diagnostics

interface ScrollGeometrySource {
  readonly scrollTop: number;
  readonly clientHeight: number;
  readonly scrollHeight: number;
}

interface VirtualItemSnapshot {
  readonly index: number;
  readonly key?: string | number | bigint;
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
  /**
   * The first virtual row intersecting the viewport. Keeping both TanStack's
   * calculated offset and the painted DOM offset makes transform/scrollTop
   * paint skew visible instead of reducing every jump to an ambiguous range.
   */
  readonly anchor: {
    readonly key: string;
    readonly index: number;
    readonly virtualOffset: number;
    readonly domOffset: number | null;
    readonly domHeight: number | null;
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

interface RecordChatPaginationDiagnosticInput {
  readonly event: string;
  readonly threadId: string;
  readonly dataCount: number;
  readonly element?: ScrollGeometrySource | null;
  readonly detail?: Readonly<Record<string, unknown>>;
}

const MAX_SAMPLES = 2_000;
const DIAGNOSTICS_SESSION_KEY = "penkra:chat-scroll-diagnostics-enabled";

function readSessionEnabled(): boolean {
  if (typeof sessionStorage === "undefined") return false;
  try {
    return sessionStorage.getItem(DIAGNOSTICS_SESSION_KEY) === "1";
  } catch {
    return false;
  }
}

function writeSessionEnabled(enabled: boolean): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    if (enabled) {
      sessionStorage.setItem(DIAGNOSTICS_SESSION_KEY, "1");
    } else {
      sessionStorage.removeItem(DIAGNOSTICS_SESSION_KEY);
    }
  } catch {
    // Diagnostics must remain optional when renderer storage is unavailable.
  }
}

const state = {
  enabled: readSessionEnabled(),
  logToConsole: false,
  nextInstanceId: 1,
  nextSequence: 1,
  samples: [] as ChatScrollDiagnosticSample[],
};

function diagnosticsAvailable(): boolean {
  return typeof performance !== "undefined";
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

function readSemanticAnchor(
  element: ScrollGeometrySource | null | undefined,
  virtualizer: TranscriptVirtualizerDiagnosticsSource | null | undefined,
): ChatScrollDiagnosticSample["anchor"] {
  if (!element || !virtualizer?.getVirtualItems) return null;
  let virtualItems: readonly VirtualItemSnapshot[];
  try {
    virtualItems = virtualizer.getVirtualItems();
  } catch {
    return null;
  }
  const anchor =
    virtualItems.find((item) => item.end > element.scrollTop + 0.5) ?? virtualItems.at(0) ?? null;
  if (!anchor) return null;

  let key = anchor.key === undefined ? String(anchor.index) : String(anchor.key);
  let domOffset: number | null = null;
  let domHeight: number | null = null;
  if (typeof HTMLElement !== "undefined" && element instanceof HTMLElement) {
    const row = element.querySelector<HTMLElement>(`[data-index="${anchor.index}"]`);
    if (row) {
      key = row.getAttribute("data-row-key") ?? key;
      const rowRect = row.getBoundingClientRect();
      const viewportRect = element.getBoundingClientRect();
      domOffset = finiteOrNull(rowRect.top - viewportRect.top);
      domHeight = finiteOrNull(rowRect.height);
    }
  }
  return {
    key,
    index: anchor.index,
    virtualOffset: anchor.start - element.scrollTop,
    domOffset,
    domHeight,
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

function appendChatDiagnostic(
  input: RecordChatScrollDiagnosticInput,
  options: { alwaysInDev: boolean; consoleLabel: string },
): void {
  if (!diagnosticsAvailable() || (!options.alwaysInDev && !state.enabled)) return;
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
    anchor: readSemanticAnchor(input.element, input.virtualizer),
  };
  state.nextSequence += 1;
  state.samples.push(sample);
  if (state.samples.length > MAX_SAMPLES) {
    state.samples.splice(0, state.samples.length - MAX_SAMPLES);
  }
  if (options.alwaysInDev || state.logToConsole) {
    console.debug(options.consoleLabel, sample);
  }
}

export function recordChatScrollDiagnostic(input: RecordChatScrollDiagnosticInput): void {
  appendChatDiagnostic(input, { alwaysInDev: false, consoleLabel: "[chat-scroll]" });
}

/**
 * Adds page-request, merge, row-derivation, and prepend checkpoints to the same
 * bounded trace as transcript geometry. Pagination deliberately uses a stable
 * synthetic instance so its records can be correlated by `threadId` and the
 * request id carried in `detail` without coupling the store to a mounted list.
 */
export function recordChatPaginationDiagnostic(input: RecordChatPaginationDiagnosticInput): void {
  appendChatDiagnostic(
    {
      instanceId: 0,
      event: `pagination:${input.event}`,
      dataCount: input.dataCount,
      anchorRevision: input.threadId,
      ...(input.element === undefined ? {} : { element: input.element }),
      detail: {
        threadId: input.threadId,
        ...(input.detail ?? {}),
      },
    },
    { alwaysInDev: false, consoleLabel: "[chat-pagination]" },
  );
}

export function enableChatScrollDiagnostics(options?: { logToConsole?: boolean }): void {
  if (!diagnosticsAvailable()) return;
  state.enabled = true;
  state.logToConsole = options?.logToConsole ?? false;
  writeSessionEnabled(true);
}

export function disableChatScrollDiagnostics(): void {
  state.enabled = false;
  state.logToConsole = false;
  writeSessionEnabled(false);
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
    anchor: sample.anchor ? { ...sample.anchor } : null,
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

// The hook is present in packaged builds so a failing installation can be
// observed in place. Recording remains disabled by default, bounded by
// MAX_SAMPLES, and contains geometry/identity metadata rather than transcript
// text.
if (typeof window !== "undefined") {
  window.penkraChatScroll = {
    enable: enableChatScrollDiagnostics,
    disable: disableChatScrollDiagnostics,
    reset: resetChatScrollDiagnostics,
    samples: getChatScrollDiagnosticSamples,
  };
}
