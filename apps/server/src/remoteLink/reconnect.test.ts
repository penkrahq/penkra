import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayReconnectLoop, type RelayAttemptEnd, type RelayReconnectState } from "./reconnect";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fixture() {
  const attempts: Array<{
    signal: AbortSignal;
    complete: (end: RelayAttemptEnd) => void;
  }> = [];
  const states: RelayReconnectState[] = [];
  let change = Promise.withResolvers<void>();
  const loop = new RelayReconnectLoop({
    attempt: (signal) => {
      const result = Promise.withResolvers<RelayAttemptEnd>();
      attempts.push({ signal, complete: result.resolve });
      signal.addEventListener("abort", () => result.resolve({ reason: "transport-failed" }), {
        once: true,
      });
      change.resolve();
      return result.promise;
    },
    observe: (state) => {
      states.push(state);
      change.resolve();
    },
  });
  return {
    loop,
    attempts,
    states,
    async until(predicate: () => boolean) {
      while (!predicate()) {
        change = Promise.withResolvers<void>();
        await change.promise;
      }
    },
  };
}

describe("relay reconnect lifetime", () => {
  it("backs off only after failures, doubles to the cap, and leaves a live attempt alone", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const f = fixture();
    try {
      await vi.advanceTimersByTimeAsync(1_000_000);
      expect(f.attempts).toHaveLength(1);
      for (const delayMs of [2500, 5000, 10000, 15000, 15000]) {
        const count = f.attempts.length;
        f.attempts.at(-1)!.complete({ reason: "transport-failed" });
        await f.until(() => f.states.at(-1)?.state === "waiting");
        expect(f.states.at(-1)).toEqual({ state: "waiting", delayMs });
        await vi.advanceTimersByTimeAsync(delayMs - 1);
        expect(f.attempts).toHaveLength(count);
        await vi.advanceTimersByTimeAsync(1);
        expect(f.attempts).toHaveLength(count + 1);
      }
    } finally {
      await f.loop.close();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["wake", "network-path", "sign-in", "access-enabled"] as const)(
    "%s cancels the pending delay and resets backoff",
    async (event) => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(0.5);
      const f = fixture();
      try {
        f.attempts[0]!.complete({ reason: "transport-failed" });
        await f.until(() => f.states.at(-1)?.state === "waiting");
        f.loop.reconnect(event);
        await f.until(() => f.attempts.length === 2);
        expect(vi.getTimerCount()).toBe(0);
        f.attempts[1]!.complete({ reason: "transport-failed" });
        await f.until(() => f.states.at(-1)?.state === "waiting");
        expect(f.states.at(-1)).toEqual({ state: "waiting", delayMs: 2500 });
      } finally {
        await f.loop.close();
      }
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["authentication-rejected", "protocol-rejected"] as const)(
    "%s has no timed retry; an explicit lifecycle event can reconnect",
    async (reason) => {
      vi.useFakeTimers();
      const f = fixture();
      try {
        f.attempts[0]!.complete({ reason });
        await f.until(() => f.states.at(-1)?.state === "rejected");
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(1_000_000);
        expect(f.attempts).toHaveLength(1);
        f.loop.reconnect("sign-in");
        await f.until(() => f.attempts.length === 2);
      } finally {
        await f.loop.close();
      }
    },
  );

  it("waits for the old attempt's cleanup before replacing it, coalescing simultaneous events", async () => {
    const release = Promise.withResolvers<RelayAttemptEnd>();
    const second = Promise.withResolvers<void>();
    let calls = 0;
    let oldSignal: AbortSignal | undefined;
    const loop = new RelayReconnectLoop({
      attempt: async (signal) => {
        calls++;
        if (calls === 1) {
          oldSignal = signal;
          return release.promise;
        }
        second.resolve();
        return new Promise((resolve) =>
          signal.addEventListener("abort", () => resolve({ reason: "transport-failed" }), {
            once: true,
          }),
        );
      },
      observe: () => undefined,
    });
    try {
      loop.reconnect("wake");
      loop.reconnect("network-path");
      expect(oldSignal?.aborted).toBe(true);
      expect(calls).toBe(1);
      release.resolve({ reason: "transport-failed" });
      await second.promise;
      expect(calls).toBe(2);
    } finally {
      release.resolve({ reason: "transport-failed" });
      await loop.close();
    }
    loop.reconnect("wake");
    expect(calls).toBe(2);
  });
});
