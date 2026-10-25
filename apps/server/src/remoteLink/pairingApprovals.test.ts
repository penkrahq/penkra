import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PAIRING_REQUEST_TTL_MS,
  PairingCancelled,
  RemotePairingApprovals,
  type RemotePairingRequest,
} from "./pairingApprovals";

afterEach(() => vi.useRealTimers());
const request = (phoneDeviceId = "phone-a") => ({
  phoneDeviceId,
  phoneName: "Test iPhone",
  phoneModel: "Test model",
  code: "012345",
});

describe("pairing consent ownership", () => {
  it.each([true, false])("only the current request can receive answer %s, once", async (allow) => {
    vi.useFakeTimers();
    const changes: Array<RemotePairingRequest | null> = [];
    const approvals = new RemotePairingApprovals((value) => changes.push(value));
    const decision = approvals.request(request(), new AbortController().signal);
    const id = approvals.current!.requestId;
    expect(approvals.answer("unknown", allow)).toBe(false);
    expect(approvals.answer(id, allow)).toBe(true);
    expect(await decision).toBe(allow ? "allow" : "deny");
    expect(approvals.answer(id, !allow)).toBe(false);
    expect(changes.map((value) => value?.requestId ?? null)).toEqual([id, null]);
    expect(vi.getTimerCount()).toBe(0);
    approvals.close();
  });

  it("expires on the Mac's exact deadline, not a transport disconnect", async () => {
    vi.useFakeTimers();
    const approvals = new RemotePairingApprovals(() => undefined);
    const decision = approvals.request(request(), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(PAIRING_REQUEST_TTL_MS - 1);
    expect(approvals.current).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(await decision).toBe("expired");
    expect(approvals.current).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("session cancellation dismisses without claiming denial or expiry", async () => {
    vi.useFakeTimers();
    const approvals = new RemotePairingApprovals(() => undefined);
    const session = new AbortController();
    const checked = expect(approvals.request(request(), session.signal)).rejects.toBeInstanceOf(
      PairingCancelled,
    );
    session.abort();
    await checked;
    expect(approvals.current).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a replacement from the same phone cancels the old request and ignores its late answer", async () => {
    vi.useFakeTimers();
    const approvals = new RemotePairingApprovals(() => undefined);
    const old = expect(
      approvals.request(request(), new AbortController().signal),
    ).rejects.toBeInstanceOf(PairingCancelled);
    const oldId = approvals.current!.requestId;
    const next = approvals.request({ ...request(), code: "999999" }, new AbortController().signal);
    await old;
    expect(approvals.answer(oldId, true)).toBe(false);
    expect(approvals.current?.code).toBe("999999");
    expect(vi.getTimerCount()).toBe(1);
    approvals.answer(approvals.current!.requestId, true);
    expect(await next).toBe("allow");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("independent phones retain their own requests; the single dialog advances in arrival order", async () => {
    vi.useFakeTimers();
    const approvals = new RemotePairingApprovals(() => undefined);
    const first = approvals.request(request("a"), new AbortController().signal);
    const id = approvals.current!.requestId;
    const second = approvals.request(request("b"), new AbortController().signal);
    expect(approvals.current?.requestId).toBe(id);
    approvals.answer(id, true);
    expect(await first).toBe("allow");
    expect(approvals.current?.phoneDeviceId).toBe("b");
    approvals.answer(approvals.current!.requestId, false);
    expect(await second).toBe("deny");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("close cancels every pending request and cannot be reopened by a renderer", async () => {
    vi.useFakeTimers();
    const approvals = new RemotePairingApprovals(() => {
      throw new Error("Observer unavailable");
    });
    const first = expect(
      approvals.request(request("a"), new AbortController().signal),
    ).rejects.toBeInstanceOf(PairingCancelled);
    const second = expect(
      approvals.request(request("b"), new AbortController().signal),
    ).rejects.toBeInstanceOf(PairingCancelled);
    approvals.close();
    await Promise.all([first, second]);
    expect(approvals.current).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await expect(approvals.request(request(), new AbortController().signal)).rejects.toBeInstanceOf(
      PairingCancelled,
    );
  });
});
