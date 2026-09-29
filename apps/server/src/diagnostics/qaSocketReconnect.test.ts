import { describe, expect, it } from "vitest";
import { QaSocketReconnectTracker } from "./qaSocketReconnect";

const clientId = "a".repeat(32);
const traceId = "b".repeat(32);
const signed = (trace: string | null) => ({ clientId, signature: "signed", traceId: trace });

describe("QaSocketReconnectTracker", () => {
  it("ignores URL claims without a main-issued transport ticket", () => {
    const proofs: string[] = [];
    const tracker = new QaSocketReconnectTracker(
      (id) => proofs.push(id),
      (_id, signature) => signature === "signed",
    );
    const forged = { clientId, signature: null, traceId };
    tracker.opened(forged).closed();
    tracker.opened(forged).receivedFrame('{"_tag":"Request"}');
    expect(proofs).toEqual([]);
  });

  it("requires the same signed transport to close and resume valid RPC traffic", () => {
    const proofs: string[] = [];
    const tracker = new QaSocketReconnectTracker(
      (id) => proofs.push(id),
      (_id, signature) => signature === "signed",
    );
    const first = tracker.opened(signed(null));
    const replacementBeforeClose = tracker.opened(signed(traceId));
    replacementBeforeClose.receivedFrame('{"_tag":"Request"}');
    expect(proofs).toEqual([]);
    replacementBeforeClose.closed();
    const recovered = tracker.opened(signed(traceId));
    recovered.receivedFrame("garbage");
    recovered.receivedFrame('{"_tag":"Untrusted"}');
    expect(proofs).toEqual([]);
    recovered.receivedFrame('{"_tag":"Ping"}');
    recovered.receivedFrame('{"_tag":"Ping"}');
    expect(proofs).toEqual([traceId]);
    first.closed();
  });

  it("rejects invalid IDs and frames after the replacement socket closes", () => {
    const proofs: string[] = [];
    const tracker = new QaSocketReconnectTracker(
      (id) => proofs.push(id),
      (_id, signature) => signature === "signed",
    );
    tracker.opened({ clientId: "wrong", signature: "signed", traceId }).closed();
    tracker.opened(signed(null)).closed();
    tracker.opened(signed("wrong")).closed();
    const recovered = tracker.opened(signed(traceId));
    recovered.closed();
    recovered.receivedFrame('{"_tag":"Request"}');
    expect(proofs).toEqual([]);
  });
});
