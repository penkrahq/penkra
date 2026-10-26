import { describe, expect, it, vi } from "vitest";
import type { RemoteLifecycleEvent } from "@penkra/contracts";
import { RemoteAccountLifetime } from "./accountLifetime";

function event(
  revision: number,
  accountId: string | null,
  reason: RemoteLifecycleEvent["event"] = "sign-in",
  accessOn = true,
  suspended = false,
): RemoteLifecycleEvent {
  return {
    type: "remote.lifecycle",
    revision,
    event: reason,
    snapshot: { accountServiceUrl: "https://account.example.test", accountId, accessOn, suspended },
  };
}

describe("RemoteLink account lifetime", () => {
  it("lets suspend send SLEEP before aborting its owned transport", async () => {
    let scope: AbortSignal | undefined;
    const close = vi.fn(async (reason: string) => {
      expect(reason).toBe("suspend");
      expect(scope?.aborted).toBe(false);
    });
    const owner = new RemoteAccountLifetime((_snapshot, signal) => {
      scope = signal;
      return { reconnect: () => {}, close };
    });
    const signal = new AbortController().signal;
    await owner.apply(event(0, "a", "snapshot"), signal);
    await owner.apply(event(1, "a", "suspend", true, true), signal);
    expect(scope?.aborted).toBe(true);
    await owner.close();
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("joins old cleanup before mounting replacement without waiting for new readiness", async () => {
    const stopping = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const mounted: string[] = [];
    const owner = new RemoteAccountLifetime((snapshot) => {
      mounted.push(snapshot.accountId);
      return {
        reconnect: () => {},
        close: async () => {
          if (snapshot.accountId === "a") {
            stopping.resolve();
            await release.promise;
          }
        },
      };
    });
    const signal = new AbortController().signal;
    try {
      await owner.apply(event(0, "a", "snapshot"), signal);
      const switching = owner.apply(event(1, "b"), signal);
      await stopping.promise;
      expect(mounted).toEqual(["a"]);
      release.resolve();
      await switching;
      expect(mounted).toEqual(["a", "b"]);
    } finally {
      release.resolve();
      await owner.close();
    }
  });

  it("retains failed cleanup ownership and never admits a replacement", async () => {
    const close = vi.fn(async () => {
      throw new Error("cleanup failed");
    });
    const mount = vi.fn(() => ({ close, reconnect: () => {} }));
    const owner = new RemoteAccountLifetime(mount);
    const signal = new AbortController().signal;
    await owner.apply(event(0, "a", "snapshot"), signal);
    await expect(owner.apply(event(1, "b"), signal)).rejects.toThrow("cleanup failed");
    await expect(owner.apply(event(2, "b"), signal)).rejects.toThrow("cleanup failed");
    await expect(owner.close()).rejects.toThrow("cleanup failed");
    expect(mount).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("does not mount a pending replacement after disconnect", async () => {
    const stopping = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const mount = vi.fn((_snapshot: unknown, _signal: AbortSignal) => ({
      reconnect: () => {},
      close: async () => {
        stopping.resolve();
        await release.promise;
      },
    }));
    const owner = new RemoteAccountLifetime(mount);
    const signal = new AbortController().signal;
    await owner.apply(event(0, "a", "snapshot"), signal);
    const switching = owner.apply(event(1, "b"), signal);
    await stopping.promise;
    const closing = owner.close();
    release.resolve();
    await Promise.all([switching, closing]);
    expect(mount).toHaveBeenCalledTimes(1);
    expect(mount.mock.calls[0]![1].aborted).toBe(true);
  });

  it("routes wake/network events to the current relay, and stops on off, sleep or sign-out", async () => {
    const reconnect = vi.fn();
    const close = vi.fn(async () => {});
    const mount = vi.fn(() => ({ reconnect, close }));
    const owner = new RemoteAccountLifetime(mount);
    const signal = new AbortController().signal;
    await owner.apply(event(0, "a", "snapshot"), signal);
    await owner.apply(event(1, "a", "wake"), signal);
    await owner.apply(event(2, "a", "network-path"), signal);
    expect(reconnect.mock.calls).toEqual([["wake"], ["network-path"]]);
    expect(mount).toHaveBeenCalledTimes(1);
    await owner.apply(event(3, "a", "suspend", true, true), signal);
    await owner.apply(event(4, "a", "wake"), signal);
    await owner.apply(event(5, "a", "access", false), signal);
    await owner.apply(event(6, "a", "access"), signal);
    await owner.apply(event(7, null, "sign-out"), signal);
    await owner.close();
    expect(mount).toHaveBeenCalledTimes(3);
    expect(close).toHaveBeenCalledTimes(3);
  });
});
