import { describe, expect, it } from "vitest";
import { DiagnosticsQaWindowTracker } from "./diagnosticsQaWindow";

const trace = { traceId: "1".repeat(32), spanId: "2".repeat(16) };
const source = { activeThreadId: "thread-a", views: [{ threadId: "thread-a", deckId: "deck-a" }] };

describe("DiagnosticsQaWindowTracker", () => {
  it("signs only a loaded cloned window's own state update", () => {
    const checkpoints: string[] = [];
    const proofs: string[] = [];
    const tracker = new DiagnosticsQaWindowTracker(
      (_trace, step, windowId) => checkpoints.push(`${windowId}:${step}`),
      (traceId) => proofs.push(traceId),
    );
    tracker.opened(7, trace, source);
    tracker.synced(7, { windowId: 7, revision: 1, ...source });
    tracker.loaded(8);
    tracker.synced(8, { windowId: 8, revision: 1, ...source });
    expect(proofs).toEqual([]);
    tracker.loaded(7);
    tracker.synced(7, { windowId: 8, revision: 1, ...source });
    expect(proofs).toEqual([]);
    tracker.synced(7, { windowId: 7, revision: 0, ...source });
    expect(proofs).toEqual([]);
    tracker.synced(7, { windowId: 7, revision: 1, activeThreadId: "other", views: source.views });
    tracker.synced(7, {
      windowId: 7,
      revision: 1,
      activeThreadId: source.activeThreadId,
      views: [{ threadId: "thread-a", deckId: "wrong" }],
    });
    expect(proofs).toEqual([]);
    tracker.synced(7, { windowId: 7, revision: 1, ...source });
    tracker.synced(7, { windowId: 7, revision: 2, ...source });
    expect(checkpoints).toEqual(["7:window.opened", "7:window.synced"]);
    expect(proofs).toEqual([trace.traceId]);
  });

  it("does not sign a window closed before sync", () => {
    const proofs: string[] = [];
    const tracker = new DiagnosticsQaWindowTracker(
      () => {},
      (traceId) => proofs.push(traceId),
    );
    tracker.opened(7, trace, source);
    tracker.loaded(7);
    tracker.closed(7);
    tracker.synced(7, { windowId: 7, revision: 1, ...source });
    expect(proofs).toEqual([]);
  });

  it("does not sign a clone without an app-owned source snapshot", () => {
    const proofs: string[] = [];
    const tracker = new DiagnosticsQaWindowTracker(
      () => {},
      (traceId) => proofs.push(traceId),
    );
    tracker.opened(7, trace, null);
    tracker.loaded(7);
    tracker.synced(7, { windowId: 7, revision: 1, ...source });
    expect(proofs).toEqual([]);
  });
});
