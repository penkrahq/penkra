import { describe, expect, it } from "vitest";
import { NOISE_MAX_MESSAGE_BYTES } from "./noise";
import { TunnelSendWindow, TUNNEL_MAX_INFLIGHT_BYTES } from "./sendWindow";

async function fill(window: TunnelSendWindow) {
  let remaining = TUNNEL_MAX_INFLIGHT_BYTES,
    seq = 0;
  while (remaining > 0) {
    const bytes = Math.min(remaining, NOISE_MAX_MESSAGE_BYTES);
    (await window.reserve({ id: 1, seq, bytes })).sent();
    remaining -= bytes;
    seq += 1;
  }
  return seq;
}
describe("TunnelSendWindow", () => {
  it("waits at exactly the approved window and resumes only when consumed chunks are acknowledged", async () => {
    const window = new TunnelSendWindow();
    const chunks = await fill(window);
    expect(window.snapshot().bytes).toBe(TUNNEL_MAX_INFLIGHT_BYTES);
    const pending = window.reserve({ id: 2, seq: 0, bytes: NOISE_MAX_MESSAGE_BYTES });
    expect(window.snapshot().waiting).toBe(1);
    expect(window.snapshot().chunks).toBe(chunks);
    expect(() => window.acknowledge(2, 0)).toThrow("unknown-ack");
    window.acknowledge(1, 0);
    (await pending).sent();
    expect(window.snapshot().bytes).toBe(TUNNEL_MAX_INFLIGHT_BYTES);
    expect(window.snapshot().waiting).toBe(0);
    window.close();
  });
  it("cancels a blocked producer without leaking a waiter or reserving bytes", async () => {
    const window = new TunnelSendWindow();
    await fill(window);
    const controller = new AbortController();
    const pending = window.reserve({ id: 2, seq: 0, bytes: 1 }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(window.snapshot().waiting).toBe(0);
    expect(window.snapshot().bytes).toBe(TUNNEL_MAX_INFLIGHT_BYTES);
    window.acknowledge(1, 0);
    (await window.reserve({ id: 2, seq: 0, bytes: 1 })).cancel();
    window.close();
  });
  it("can release an unsent reservation but never reclaim dispatched bytes without an acknowledgement", async () => {
    const window = new TunnelSendWindow();
    const first = await window.reserve({ id: 1, seq: 0, bytes: 100 });
    expect(() => window.acknowledge(1, 0)).toThrow("unknown-ack");
    first.cancel();
    expect(window.snapshot().bytes).toBe(0);
    const sent = await window.reserve({ id: 1, seq: 0, bytes: 100 });
    expect(() => first.sent()).toThrow("invalid-state");
    sent.sent();
    expect(() => sent.cancel()).toThrow("invalid-state");
    window.acknowledge(1, 0);
    expect(() => window.acknowledge(1, 0)).toThrow("unknown-ack");
    expect(window.snapshot().bytes).toBe(0);
  });
  it("closes all blocked producers and rejects stale leases and future work", async () => {
    const window = new TunnelSendWindow();
    const lease = await window.reserve({ id: 3, seq: 0, bytes: 1 });
    lease.cancel();
    await fill(window);
    const pending = window.reserve({ id: 2, seq: 0, bytes: 1 });
    const second = window.reserve({ id: 4, seq: 0, bytes: 1 });
    window.close();
    await expect(pending).rejects.toMatchObject({ code: "closed" });
    await expect(second).rejects.toMatchObject({ code: "closed" });
    expect(window.snapshot()).toEqual({ bytes: 0, chunks: 0, waiting: 0, closed: true });
    expect(() => lease.sent()).toThrow("closed");
    await expect(window.reserve({ id: 4, seq: 0, bytes: 1 })).rejects.toMatchObject({
      code: "closed",
    });
  });
  it("rejects invalid sizes, identities and duplicate reservations", async () => {
    const window = new TunnelSendWindow();
    for (const input of [
      { id: 0, seq: 0, bytes: 1 },
      { id: 1, seq: -1, bytes: 1 },
      { id: 1, seq: 0, bytes: 0 },
      { id: 1, seq: 0, bytes: NOISE_MAX_MESSAGE_BYTES + 1 },
    ])
      await expect(window.reserve(input)).rejects.toMatchObject({ code: "invalid-chunk" });
    const lease = await window.reserve({ id: 1, seq: 0, bytes: 1 });
    await expect(window.reserve({ id: 1, seq: 0, bytes: 1 })).rejects.toMatchObject({
      code: "invalid-state",
    });
    lease.cancel();
    expect(window.snapshot().bytes).toBe(0);
  });
});
