import { describe, expect, it, vi } from "vitest";
import { RelayFrameType, RelayOpenMode, type RelayFrame } from "./relayProtocol";
import { RelaySessions } from "./relaySessions";

const frame = (type: RelayFrameType, peerId = "phone", sessionId = "session"): RelayFrame => ({
  type,
  peerId,
  sessionId,
  payload: new Uint8Array([1]),
  ...(type === RelayFrameType.OPEN ? { mode: RelayOpenMode.SESSION } : {}),
});

describe("relay session ownership", () => {
  it("routes data independently and joins every aborted session on disconnect", async () => {
    const entries: {
      signal: AbortSignal;
      data: Uint8Array[];
      done: ReturnType<typeof Promise.withResolvers<void>>;
    }[] = [];
    const closePeer = vi.fn(async () => undefined);
    const router = new RelaySessions({
      start: (_open, signal) => {
        const entry = { signal, data: [] as Uint8Array[], done: Promise.withResolvers<void>() };
        entries.push(entry);
        return { receive: (value) => entry.data.push(value), finished: entry.done.promise };
      },
      closePeer,
      observeFailure: () => undefined,
    });
    router.receive(frame(RelayFrameType.OPEN, "one"));
    router.receive(frame(RelayFrameType.OPEN, "two"));
    router.receive(frame(RelayFrameType.DATA, "one"));
    expect(entries[0]!.data).toHaveLength(1);
    expect(entries[1]!.data).toHaveLength(0);
    router.receive(frame(RelayFrameType.CLOSE, "one"));
    expect(entries[0]!.signal.aborted).toBe(true);
    expect(entries[1]!.signal.aborted).toBe(false);
    let done = false;
    const closing = router.close().then(() => {
      done = true;
    });
    entries[1]!.done.resolve();
    await Promise.resolve();
    expect(done).toBe(false);
    entries[0]!.done.resolve();
    await closing;
    expect(entries[1]!.signal.aborted).toBe(true);
    expect(closePeer).not.toHaveBeenCalled();
  });
});
