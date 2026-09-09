import { MessageId, ThreadId } from "@penkra/contracts";
import { describe, expect, it, vi } from "vitest";

import { PendingStartRecoveryRegistry } from "./pendingStartRecoveryRegistry";

const threadId = ThreadId.makeUnsafe("thread:recovery");
const messageId = MessageId.makeUnsafe("message:recovery");
const restoration = { threadId, messageId, previewUrls: [], restore: vi.fn(async () => {}) };

describe("PendingStartRecoveryRegistry", () => {
  it("coalesces held triggers into one request and one latest-frontier followup", async () => {
    const registry = new PendingStartRecoveryRegistry<typeof restoration>();
    registry.register(restoration);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const frontiers: number[] = [];
    const lookup = vi.fn(async (minimumSequence: number) => {
      frontiers.push(minimumSequence);
      if (frontiers.length === 1) await gate;
      return {
        threadId,
        messageId,
        snapshotSequence: minimumSequence,
        threadExists: true,
        outcome: "unknown" as const,
      };
    });
    const first = registry.request({
      threadId,
      messageId,
      minimumSequence: 3,
      lookup,
      restoreCancelled: restoration.restore,
    });
    await registry.request({
      threadId,
      messageId,
      minimumSequence: 4,
      lookup,
      restoreCancelled: restoration.restore,
    });
    await registry.request({
      threadId,
      messageId,
      minimumSequence: 9,
      lookup,
      restoreCancelled: restoration.restore,
    });
    expect(lookup).toHaveBeenCalledTimes(1);
    release();
    await first;
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(2));
    expect(frontiers).toEqual([3, 9]);
  });

  it("keeps exact thread/message owners independent", () => {
    const registry = new PendingStartRecoveryRegistry<typeof restoration>();
    const other = {
      ...restoration,
      threadId: ThreadId.makeUnsafe("thread"),
      messageId: MessageId.makeUnsafe("recovery:message"),
    };
    registry.register(restoration);
    registry.register(other);
    expect(registry.release(threadId, messageId)).toBe(restoration);
    expect(registry.get(other.threadId, other.messageId)).toBe(other);
  });

  it("exposes a hydrated owner before a frontier trigger", () => {
    const registry = new PendingStartRecoveryRegistry<typeof restoration>();
    registry.register(restoration);
    expect(registry.entriesForThread(threadId)).toEqual([{ restoration, frontier: 0 }]);
  });

  it("keeps a fresh local owner out of reload lookup until a frontier activates it", () => {
    const registry = new PendingStartRecoveryRegistry<typeof restoration>();
    registry.register(restoration, { deferLookup: true });
    expect(registry.entriesForThread(threadId)).toEqual([]);
    registry.setFrontier(threadId, messageId, 12);
    expect(registry.entriesForThread(threadId)).toEqual([{ restoration, frontier: 12 }]);
  });

  it("passes the authoritative cancellation frontier to restoration", async () => {
    const registry = new PendingStartRecoveryRegistry<typeof restoration>();
    registry.register(restoration);
    const restore = vi.fn(async (_owner: typeof restoration, sequence?: number) => {
      expect(sequence).toBe(42);
    });
    await registry.request({
      threadId,
      messageId,
      minimumSequence: 1,
      lookup: async () => ({
        threadId,
        messageId,
        snapshotSequence: 42,
        threadExists: true,
        outcome: "cancelled" as const,
      }),
      restoreCancelled: restore,
    });
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it("does not discard restoration until cancellation restoration succeeds", async () => {
    const registry = new PendingStartRecoveryRegistry<typeof restoration>();
    registry.register(restoration);
    await registry.request({
      threadId,
      messageId,
      minimumSequence: 1,
      lookup: async () => ({
        threadId,
        messageId,
        snapshotSequence: 1,
        threadExists: true,
        outcome: "cancelled",
      }),
      restoreCancelled: async () => {
        throw new Error("restore failed");
      },
    });
    expect(registry.get(threadId, messageId)).toBe(restoration);
  });

  it.each(["query-failed", "thread-missing"] as const)(
    "settles only the exact owner for %s without restoring",
    async (outcomeKind) => {
      const registry = new PendingStartRecoveryRegistry<typeof restoration>();
      const other = {
        ...restoration,
        messageId: MessageId.makeUnsafe("message:other"),
        restore: vi.fn(async () => {}),
      };
      registry.register(restoration);
      registry.register(other);
      await registry.request({
        threadId,
        messageId,
        minimumSequence: 1,
        lookup: async () => ({
          threadId,
          messageId,
          snapshotSequence: 1,
          threadExists: outcomeKind !== "thread-missing",
          outcome: outcomeKind === "query-failed" ? "failed" : "unknown",
        }),
        restoreCancelled: restoration.restore,
      });
      if (outcomeKind === "thread-missing") {
        expect(registry.get(threadId, messageId)).toBe(restoration);
      } else {
        expect(registry.get(threadId, messageId)).toBeUndefined();
      }
      expect(registry.get(threadId, other.messageId)).toBe(other);
      expect(restoration.restore).not.toHaveBeenCalled();
    },
  );

  it("keeps an unknown outcome unresolved for a later authoritative trigger", async () => {
    const registry = new PendingStartRecoveryRegistry<typeof restoration>();
    registry.register(restoration);
    await registry.request({
      threadId,
      messageId,
      minimumSequence: 1,
      lookup: async () => ({
        threadId,
        messageId,
        snapshotSequence: 1,
        threadExists: true,
        outcome: "unknown",
      }),
      restoreCancelled: restoration.restore,
    });
    expect(registry.get(threadId, messageId)).toBe(restoration);
  });

  it("requires durable cleanup before releasing an authoritative failed owner", async () => {
    const registry = new PendingStartRecoveryRegistry<typeof restoration>();
    registry.register(restoration);
    const cleanup = vi.fn(async (_owner: typeof restoration, sequence: number) => {
      expect(sequence).toBe(17);
    });
    await registry.request({
      threadId,
      messageId,
      minimumSequence: 1,
      lookup: async () => ({
        threadId,
        messageId,
        snapshotSequence: 17,
        threadExists: true,
        outcome: "failed" as const,
      }),
      restoreCancelled: restoration.restore,
      fail: cleanup,
    });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(registry.get(threadId, messageId)).toBeUndefined();
  });

  it("coalesces concurrent accepted settlement callbacks for one exact message", async () => {
    const registry = new PendingStartRecoveryRegistry<typeof restoration>();
    const threadId = ThreadId.makeUnsafe("thread-accepted-race-green");
    const messageId = MessageId.makeUnsafe("message-accepted-race-green");
    registry.register({
      threadId,
      messageId,
      previewUrls: [],
      restore: restoration.restore,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const accept = vi.fn(async () => gate);
    const first = registry.settleAccepted(threadId, messageId, 21, accept);
    const second = registry.settleAccepted(threadId, messageId, 21, accept);
    release();
    await Promise.all([first, second]);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(registry.get(threadId, messageId)).toBeUndefined();
  });

  it("joins a remounted owner by thread and message without sharing another thread", async () => {
    const registry = new PendingStartRecoveryRegistry<typeof restoration>();
    const firstThreadId = ThreadId.makeUnsafe("thread-remount-settlement-green");
    const secondThreadId = ThreadId.makeUnsafe("thread-remount-isolated-green");
    const messageId = MessageId.makeUnsafe("message-remount-settlement-green");
    const firstRestoration: typeof restoration = {
      threadId: firstThreadId,
      messageId,
      previewUrls: [],
      restore: restoration.restore,
    };
    const remountedRestoration: typeof restoration = {
      ...firstRestoration,
      threadId: firstThreadId,
    };
    const isolatedRestoration: typeof restoration = {
      ...firstRestoration,
      threadId: secondThreadId,
    };
    registry.register(firstRestoration);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstSettle = vi.fn(async () => gate);
    const remountedSettle = vi.fn(async () => undefined);
    const isolatedSettle = vi.fn(async () => undefined);
    const first = registry.settleExact(firstThreadId, messageId, firstRestoration, firstSettle, 30);
    const remounted = registry.settleExact(
      firstThreadId,
      messageId,
      remountedRestoration,
      remountedSettle,
      30,
    );
    const isolated = registry.settleExact(
      secondThreadId,
      messageId,
      isolatedRestoration,
      isolatedSettle,
      30,
    );
    await isolated;
    expect(firstSettle).toHaveBeenCalledTimes(1);
    expect(remountedSettle).not.toHaveBeenCalled();
    expect(isolatedSettle).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, remounted]);
    expect(registry.get(firstThreadId, messageId)).toBeUndefined();
    expect(registry.get(secondThreadId, messageId)).toBeUndefined();
  });

  it("retains a transport rejection and restores on a later cancelled trigger", async () => {
    const registry = new PendingStartRecoveryRegistry<typeof restoration>();
    const restore = vi.fn(async () => {});
    registry.register({ ...restoration, restore });
    await registry.request({
      threadId,
      messageId,
      minimumSequence: 1,
      lookup: async () => {
        throw new Error("disconnected");
      },
      restoreCancelled: restore,
    });
    expect(registry.get(threadId, messageId)).toBeDefined();
    await registry.request({
      threadId,
      messageId,
      minimumSequence: 2,
      lookup: async () => ({
        threadId,
        messageId,
        snapshotSequence: 2,
        threadExists: true,
        outcome: "cancelled",
      }),
      restoreCancelled: restore,
    });
    expect(restore).toHaveBeenCalledTimes(1);
    expect(registry.get(threadId, messageId)).toBeUndefined();
  });

  it("uses the latest remounted callbacks for the bounded followup", async () => {
    const registry = new PendingStartRecoveryRegistry<typeof restoration>();
    registry.register(restoration);
    let rejectOld!: (error: Error) => void;
    const oldLookup = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectOld = reject;
        }),
    );
    const oldRestore = vi.fn(async () => {});
    const newRestore = vi.fn(async () => {});
    const first = registry.request({
      threadId,
      messageId,
      minimumSequence: 1,
      lookup: oldLookup,
      restoreCancelled: oldRestore,
    });
    await registry.request({
      threadId,
      messageId,
      minimumSequence: 7,
      lookup: async () => ({
        threadId,
        messageId,
        snapshotSequence: 7,
        threadExists: true,
        outcome: "cancelled",
      }),
      restoreCancelled: newRestore,
    });
    rejectOld(new Error("old view disconnected"));
    await first;
    await vi.waitFor(() => expect(newRestore).toHaveBeenCalledTimes(1));
    expect(oldRestore).not.toHaveBeenCalled();
  });

  it("shares one cancellation settlement between pushed and lookup outcomes", async () => {
    const registry = new PendingStartRecoveryRegistry<typeof restoration>();
    registry.register(restoration);
    let releaseRestore!: () => void;
    const restoreGate = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    const draft = { prompt: "newer draft", recoveredOwners: [] as string[] };
    const restore = vi.fn(async () => {
      await restoreGate;
      draft.recoveredOwners.push("original pending start");
    });
    const pushed = registry.settleCancelled(threadId, messageId, 1, restore);
    const lookup = registry.request({
      threadId,
      messageId,
      minimumSequence: 1,
      lookup: async () => ({
        threadId,
        messageId,
        snapshotSequence: 1,
        threadExists: true,
        outcome: "cancelled",
      }),
      restoreCancelled: restore,
    });
    await vi.waitFor(() => expect(restore).toHaveBeenCalledTimes(1));
    releaseRestore();
    await Promise.all([pushed, lookup]);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(draft).toEqual({
      prompt: "newer draft",
      recoveredOwners: ["original pending start"],
    });
    expect(registry.get(threadId, messageId)).toBeUndefined();
  });

  it("claims cancellation settlement before a restoration can reenter", async () => {
    const registry = new PendingStartRecoveryRegistry<typeof restoration>();
    registry.register(restoration);
    let reentrant: Promise<void> | undefined;
    const restore = vi.fn(async () => {
      if (restore.mock.calls.length === 1) {
        reentrant = registry.settleCancelled(threadId, messageId, 1, restore);
      }
    });
    await registry.settleCancelled(threadId, messageId, 1, restore);
    await reentrant;
    expect(restore).toHaveBeenCalledTimes(1);
  });
});
