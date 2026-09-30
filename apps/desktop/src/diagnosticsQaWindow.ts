import type { DiagnosticTraceContext } from "@penkra/contracts";

const THREAD_ROUTE = /^\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/iu;

/** Electron observes this URL independently of the renderer's thread-home IPC. */
export function qaThreadRouteFromUrl(raw: string): string | null {
  try {
    return new URL(raw).hash.slice(1).match(THREAD_ROUTE)?.[1] ?? null;
  } catch {
    return null;
  }
}

type WindowState = { trace: DiagnosticTraceContext; loaded: boolean; sourceThreadId: string };

/** A clone proves sync after its own load, route, and matching applied state. */
export class DiagnosticsQaWindowTracker {
  private readonly pending = new Map<number, WindowState>();

  constructor(
    private readonly checkpoint: (
      trace: DiagnosticTraceContext,
      step: "window.opened" | "window.synced",
      windowId: number,
    ) => void,
    private readonly proof: (traceId: string) => void,
  ) {}

  opened(windowId: number, trace: DiagnosticTraceContext, sourceUrl: string): void {
    const sourceThreadId = qaThreadRouteFromUrl(sourceUrl);
    if (!sourceThreadId) return;
    this.pending.set(windowId, { trace, loaded: false, sourceThreadId });
    this.checkpoint(trace, "window.opened", windowId);
  }

  loaded(windowId: number): void {
    const state = this.pending.get(windowId);
    if (state) state.loaded = true;
  }

  synced(
    windowId: number,
    applied: {
      readonly windowId: number;
      readonly revision: number;
      readonly activeThreadId: string;
      readonly cloneUrl: string;
    },
  ): void {
    const state = this.pending.get(windowId);
    if (!state?.loaded || applied.windowId !== windowId || applied.revision < 1) return;
    if (applied.activeThreadId !== state.sourceThreadId) return;
    if (qaThreadRouteFromUrl(applied.cloneUrl) !== state.sourceThreadId) return;
    this.pending.delete(windowId);
    this.checkpoint(state.trace, "window.synced", windowId);
    this.proof(state.trace.traceId);
  }

  closed(windowId: number): void {
    this.pending.delete(windowId);
  }
}
