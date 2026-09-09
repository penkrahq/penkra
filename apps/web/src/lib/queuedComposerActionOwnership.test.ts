import { MessageId, ThreadId } from "@penkra/contracts";
import { describe, expect, it } from "vitest";

import { QueuedComposerActionOwnership } from "./queuedComposerActionOwnership";

const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");

describe("QueuedComposerActionOwnership", () => {
  it("ignores repeated and conflicting actions for one queued message", () => {
    const ownership = new QueuedComposerActionOwnership();
    const first = ownership.claim(THREAD_A, "queued-1", "steer");
    expect(first?.action).toBe("steer");
    expect(ownership.claim(THREAD_A, "queued-1", "steer")).toBeNull();
    expect(ownership.claim(THREAD_A, "queued-1", "delete")).toBeNull();
    expect(ownership.claim(THREAD_A, "queued-1", "edit")).toBeNull();
  });

  it("allows actions for different queued messages independently", () => {
    const ownership = new QueuedComposerActionOwnership();
    expect(ownership.claim(THREAD_A, "queued-1", "steer")).not.toBeNull();
    expect(ownership.claim(THREAD_A, "queued-2", "delete")).not.toBeNull();
  });

  it("allows a truthful retry after rejection releases ownership", () => {
    const ownership = new QueuedComposerActionOwnership();
    const failed = ownership.claim(THREAD_A, "queued-1", "edit")!;
    failed.release();
    expect(ownership.claim(THREAD_A, "queued-1", "edit")).not.toBeNull();
  });

  it("retains ownership across view unsubscribe and remount", () => {
    const ownership = new QueuedComposerActionOwnership();
    const updates: number[] = [];
    const unsubscribe = ownership.subscribe(() => updates.push(ownership.getRevision()));
    const claim = ownership.claim(THREAD_A, "queued-1", "steer")!;
    unsubscribe();
    expect(ownership.claim(THREAD_A, "queued-1", "edit")).toBeNull();
    expect(ownership.inFlightIds(THREAD_A)).toEqual(new Set(["queued-1"]));
    expect(ownership.claim(THREAD_B, "queued-1", "delete")).not.toBeNull();
    claim.release();
    expect(ownership.claim(THREAD_A, "queued-1", "edit")).not.toBeNull();
    expect(updates).toEqual([1]);
  });

  it("does not settle an accepted action from an older or omitted snapshot", () => {
    const ownership = new QueuedComposerActionOwnership();
    const claim = ownership.claim(THREAD_A, "queued-accepted", "delete")!;
    claim.release();
    const messageId = MessageId.makeUnsafe("message-accepted");
    ownership.markAccepted(THREAD_A, messageId, 10);

    ownership.reconcileAccepted(THREAD_A, new Map());
    expect(ownership.acceptedMessageIds(THREAD_A)).toEqual(new Set([messageId]));

    ownership.reconcileAccepted(THREAD_A, new Map([[messageId, 9]]));
    expect(ownership.acceptedMessageIds(THREAD_A)).toEqual(new Set([messageId]));
  });

  it("settles only from a matching newer delivery or cancellation sequence", () => {
    const ownership = new QueuedComposerActionOwnership();
    const claim = ownership.claim(THREAD_A, "queued-settle", "edit")!;
    claim.release();
    const messageId = MessageId.makeUnsafe("message-settle");
    ownership.markAccepted(THREAD_A, messageId, 10);

    ownership.reconcileAccepted(THREAD_A, new Map([[messageId, 10]]));
    expect(ownership.acceptedMessageIds(THREAD_A)).toEqual(new Set());
  });

  it("does not collide when thread and queued message ids contain delimiters", () => {
    const ownership = new QueuedComposerActionOwnership();
    expect(ownership.claim(ThreadId.makeUnsafe("thread:a"), "queued", "steer")).not.toBeNull();
    expect(ownership.claim(ThreadId.makeUnsafe("thread"), "a:queued", "edit")).not.toBeNull();
  });
});
