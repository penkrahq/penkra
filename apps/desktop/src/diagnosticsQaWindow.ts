import type { DiagnosticTraceContext } from "@penkra/contracts";

type WindowViews = {
  readonly activeThreadId: string;
  readonly views: readonly { threadId: string; deckId: string }[];
};
type WindowState = { trace: DiagnosticTraceContext; loaded: boolean; source: WindowViews };

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

  opened(windowId: number, trace: DiagnosticTraceContext, source: WindowViews | null): void {
    if (!source) return;
    this.pending.set(windowId, { trace, loaded: false, source });
    this.checkpoint(trace, "window.opened", windowId);
  }

  loaded(windowId: number): void {
    const state = this.pending.get(windowId);
    if (state) state.loaded = true;
  }

  synced(
    windowId: number,
    applied: { readonly windowId: number; readonly revision: number } & WindowViews,
  ): void {
    const state = this.pending.get(windowId);
    if (!state?.loaded || applied.windowId !== windowId || applied.revision < 1) return;
    if (applied.activeThreadId !== state.source.activeThreadId) return;
    if (applied.views.length !== state.source.views.length) return;
    const expected = new Map(state.source.views.map((view) => [view.threadId, view.deckId]));
    if (applied.views.some((view) => expected.get(view.threadId) !== view.deckId)) return;
    this.pending.delete(windowId);
    this.checkpoint(state.trace, "window.synced", windowId);
    this.proof(state.trace.traceId);
  }

  closed(windowId: number): void {
    this.pending.delete(windowId);
  }
}
