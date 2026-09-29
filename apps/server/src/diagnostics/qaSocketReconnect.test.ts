import { describe, expect, it } from "vitest";
import { QaSocketReconnectTracker } from "./qaSocketReconnect";

const clientId = "a".repeat(32);
const traceId = "b".repeat(32);

describe("QaSocketReconnectTracker", () => {
  it("requires an actual prior socket close and a matching replacement connection", () => {
    const proofs: string[] = [];
    const tracker = new QaSocketReconnectTracker((id) => proofs.push(id));
    const close = tracker.opened(clientId, null);
    tracker.opened("c".repeat(32), traceId);
    tracker.opened(clientId, traceId);
    expect(proofs).toEqual([]);
    close();
    tracker.opened(clientId, traceId);
    expect(proofs).toEqual([]);
  });

  it("signs only after the first socket closes", () => {
    const proofs: string[] = [];
    const tracker = new QaSocketReconnectTracker((id) => proofs.push(id));
    const close = tracker.opened(clientId, null);
    close();
    tracker.opened(clientId, traceId);
    expect(proofs).toEqual([traceId]);
  });

  it("rejects invalid IDs", () => {
    const proofs: string[] = [];
    const tracker = new QaSocketReconnectTracker((id) => proofs.push(id));
    tracker.opened("wrong", traceId)();
    tracker.opened("wrong", traceId);
    tracker.opened(clientId, "wrong")();
    tracker.opened(clientId, "wrong");
    expect(proofs).toEqual([]);
  });
});
