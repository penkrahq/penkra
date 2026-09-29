import { describe, expect, it } from "vitest";
import { DiagnosticsQaWindowTracker, qaThreadRouteFromUrl } from "./diagnosticsQaWindow";

const trace = { traceId: "1".repeat(32), spanId: "2".repeat(16) };
const sourceThreadId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const sourceUrl = `http://127.0.0.1:5735/#/${sourceThreadId}`;
const source = { activeThreadId: sourceThreadId, cloneUrl: sourceUrl };

describe("DiagnosticsQaWindowTracker", () => {
  it("signs only a loaded cloned window's own state update", () => {
    const checkpoints: string[] = [];
    const proofs: string[] = [];
    const tracker = new DiagnosticsQaWindowTracker(
      (_trace, step, windowId) => checkpoints.push(`${windowId}:${step}`),
      (traceId) => proofs.push(traceId),
    );
    tracker.opened(7, trace, sourceUrl);
    tracker.synced(7, { windowId: 7, revision: 1, ...source });
    tracker.loaded(8);
    tracker.synced(8, { windowId: 8, revision: 1, ...source });
    expect(proofs).toEqual([]);
    tracker.loaded(7);
    tracker.synced(7, { windowId: 8, revision: 1, ...source });
    expect(proofs).toEqual([]);
    tracker.synced(7, { windowId: 7, revision: 0, ...source });
    expect(proofs).toEqual([]);
    tracker.synced(7, { windowId: 7, revision: 1, activeThreadId: "other", cloneUrl: sourceUrl });
    tracker.synced(7, {
      windowId: 7,
      revision: 1,
      activeThreadId: source.activeThreadId,
      cloneUrl: "http://127.0.0.1:5735/#/ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee",
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
    tracker.opened(7, trace, sourceUrl);
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
    tracker.opened(7, trace, "http://127.0.0.1:5735/#/");
    tracker.loaded(7);
    tracker.synced(7, { windowId: 7, revision: 1, ...source });
    expect(proofs).toEqual([]);
  });

  it("derives the source thread from the main-observed URL", () => {
    expect(qaThreadRouteFromUrl(sourceUrl)).toBe(sourceThreadId);
    expect(qaThreadRouteFromUrl("http://127.0.0.1:5735/#/invalid")).toBeNull();
    expect(qaThreadRouteFromUrl("malformed")).toBeNull();
  });
});
