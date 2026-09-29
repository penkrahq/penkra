import { describe, expect, it } from "vitest";
import { QaSocketReconnectTracker } from "./qaSocketReconnect";

const clientId = "a".repeat(32);
const traceId = "b".repeat(32);
let ticket = 0;
const signed = (trace: string | null) => ({
  clientId,
  ticketId: (++ticket).toString(16).padStart(32, "0"),
  signature: "signed",
  traceId: trace,
});
const request = '{"_tag":"Request","id":"1","tag":"Shell.GetState"}';
const success = '{"_tag":"Exit","requestId":"1","exit":{"_tag":"Success","value":{}}}';

describe("QaSocketReconnectTracker", () => {
  it("ignores URL claims without a main-issued transport ticket", () => {
    const proofs: string[] = [];
    const tracker = new QaSocketReconnectTracker(
      (id) => proofs.push(id),
      (_id, _ticket, signature) => signature === "signed",
    );
    const forged = { clientId, ticketId: "c".repeat(32), signature: null, traceId };
    tracker.opened(forged).closed();
    tracker.opened(forged).receivedFrame(request);
    expect(proofs).toEqual([]);
  });

  it("requires the same signed transport to close and resume valid RPC traffic", () => {
    const proofs: string[] = [];
    const tracker = new QaSocketReconnectTracker(
      (id) => proofs.push(id),
      (_id, _ticket, signature) => signature === "signed",
    );
    const first = tracker.opened(signed(null));
    const replacementBeforeClose = tracker.opened(signed(traceId));
    replacementBeforeClose.receivedFrame(request);
    replacementBeforeClose.sentFrame(success);
    expect(proofs).toEqual([]);
    replacementBeforeClose.closed();
    const recovered = tracker.opened(signed(traceId));
    recovered.receivedFrame("garbage");
    recovered.receivedFrame('{"_tag":"Untrusted"}');
    expect(proofs).toEqual([]);
    recovered.receivedFrame('{"_tag":"Ping"}');
    recovered.sentFrame('{"_tag":"Pong"}');
    expect(proofs).toEqual([]);
    recovered.receivedFrame(request);
    recovered.sentFrame('{"_tag":"Exit","requestId":"1","exit":{"_tag":"Failure"}}');
    expect(proofs).toEqual([]);
    recovered.sentFrame(success);
    recovered.sentFrame(success);
    expect(proofs).toEqual([traceId]);
    first.closed();
  });

  it("rejects invalid IDs and frames after the replacement socket closes", () => {
    const proofs: string[] = [];
    const tracker = new QaSocketReconnectTracker(
      (id) => proofs.push(id),
      (_id, _ticket, signature) => signature === "signed",
    );
    tracker
      .opened({ clientId: "wrong", ticketId: "c".repeat(32), signature: "signed", traceId })
      .closed();
    tracker.opened(signed(null)).closed();
    tracker.opened(signed("wrong")).closed();
    const recovered = tracker.opened(signed(traceId));
    recovered.closed();
    recovered.receivedFrame(request);
    recovered.sentFrame(success);
    expect(proofs).toEqual([]);
  });

  it("consumes a ticket once, even after its socket closes", () => {
    const proofs: string[] = [];
    const tracker = new QaSocketReconnectTracker(
      (id) => proofs.push(id),
      (_id, _ticket, signature) => signature === "signed",
    );
    tracker.opened(signed(null)).closed();
    const once = signed(traceId);
    tracker.opened(once).closed();
    const replay = tracker.opened(once);
    replay.receivedFrame(request);
    replay.sentFrame(success);
    expect(proofs).toEqual([]);
  });

  it("recognizes a successful response in batched RPC frames", () => {
    const proofs: string[] = [];
    const tracker = new QaSocketReconnectTracker(
      (id) => proofs.push(id),
      (_id, _ticket, signature) => signature === "signed",
    );
    tracker.opened(signed(null)).closed();
    const recovered = tracker.opened(signed(traceId));
    recovered.receivedFrame(`[${request}]`);
    recovered.sentFrame(`[${success}]`);
    expect(proofs).toEqual([traceId]);
  });
});
