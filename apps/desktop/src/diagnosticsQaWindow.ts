import type { DiagnosticTraceContext } from "@penkra/contracts";

type WindowState = { trace: DiagnosticTraceContext; loaded: boolean };

/** A cloned shell window proves sync only after its own load and state IPC. */
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

  opened(windowId: number, trace: DiagnosticTraceContext): void {
    this.pending.set(windowId, { trace, loaded: false });
    this.checkpoint(trace, "window.opened", windowId);
  }

  loaded(windowId: number): void {
    const state = this.pending.get(windowId);
    if (state) state.loaded = true;
  }

  synced(windowId: number): void {
    const state = this.pending.get(windowId);
    if (!state?.loaded) return;
    this.pending.delete(windowId);
    this.checkpoint(state.trace, "window.synced", windowId);
    this.proof(state.trace.traceId);
  }

  closed(windowId: number): void {
    this.pending.delete(windowId);
  }
}
