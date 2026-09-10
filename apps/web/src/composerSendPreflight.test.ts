// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MessageId, ThreadId } from "@penkra/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeQueuedChatTurn } from "./composerDraftStoreTestFixtures";

const submission = (prompt: string) => ({
  ...makeQueuedChatTurn(prompt),
  prompt,
});

import {
  advanceComposerSendPreflightAppliedSequence,
  cancelComposerSendPreflight,
  claimComposerSendPreflight,
  getComposerSendPreflight,
  getComposerSendPreflightProjection,
  getComposerDispatchedSendOwner,
  hasComposerSendActivity,
  markComposerSendPreflightDispatching,
  setComposerSendPreflightProjection,
  settleComposerSendPreflightRecovery,
  releaseComposerSendPreflight,
  markComposerSendPreflightAdmission,
  resetComposerSendPreflightsForTests,
  useHasComposerSendPreflight,
} from "./composerSendPreflight";

describe("composerSendPreflight", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(resetComposerSendPreflightsForTests);

  afterEach(() => {
    if (root !== null) act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  it("fences stale completion from a successor owner on the same thread", () => {
    const threadId = ThreadId.makeUnsafe("thread-preflight-fence");
    const first = claimComposerSendPreflight(threadId, submission("first"))!;
    expect(claimComposerSendPreflight(threadId, submission("duplicate"))).toBeNull();
    releaseComposerSendPreflight(first);

    const second = claimComposerSendPreflight(threadId, submission("second"))!;
    releaseComposerSendPreflight(first);
    expect(getComposerSendPreflight(threadId)?.id).toBe(second.id);
    expect(getComposerSendPreflight(threadId)?.capturedSubmission).toEqual(submission("second"));
  });

  it("marks a stopped owner cancelled before releasing its thread slot", () => {
    const threadId = ThreadId.makeUnsafe("thread-preflight-stop");
    const owner = claimComposerSendPreflight(threadId, submission("stop"))!;

    expect(cancelComposerSendPreflight(threadId)?.id).toBe(owner.id);
    expect(owner.cancelled).toBe(true);
    expect(getComposerSendPreflight(threadId)?.id).toBe(owner.id);
    releaseComposerSendPreflight(owner);
    expect(getComposerSendPreflight(threadId)).toBeNull();
  });

  it("settles a cancelled preflight by its claimed message identity before dispatch", () => {
    const threadId = ThreadId.makeUnsafe("thread-preflight-cancelled-capture");
    const messageId = MessageId.makeUnsafe("message-preflight-cancelled-capture");
    const owner = claimComposerSendPreflight(
      threadId,
      submission("cancelled capture"),
      [],
      messageId,
    )!;

    cancelComposerSendPreflight(threadId);
    settleComposerSendPreflightRecovery(threadId, messageId, 7);

    expect(owner.cancelled).toBe(true);
    expect(getComposerSendPreflight(threadId)).toBeNull();
  });

  it("retains one message identity and captured payload through dispatch admission", () => {
    const threadId = ThreadId.makeUnsafe("thread-preflight-dispatch");
    const messageId = MessageId.makeUnsafe("message-preflight-dispatch");
    const captured = submission("captured");
    const pending = { ...captured, messageId };
    const owner = claimComposerSendPreflight(threadId, captured)!;

    markComposerSendPreflightDispatching(owner, messageId, pending);

    expect(getComposerSendPreflight(threadId)).toMatchObject({
      id: owner.id,
      phase: "dispatching",
      messageId,
      capturedSubmission: captured,
      pendingTurn: pending,
    });
  });

  it("retains the projected message identity through dispatch admission", () => {
    const threadId = ThreadId.makeUnsafe("thread-preflight-projection");
    const messageId = MessageId.makeUnsafe("message-preflight-projection");
    const owner = claimComposerSendPreflight(threadId, submission("projected"))!;
    const projection = {
      id: messageId,
      role: "user" as const,
      text: "projected",
      createdAt: new Date().toISOString(),
      streaming: false,
    };

    setComposerSendPreflightProjection(owner, projection);
    markComposerSendPreflightDispatching(owner, messageId, {
      ...submission("projected"),
      messageId,
    });

    expect(getComposerSendPreflight(threadId)?.optimisticMessage).toEqual(projection);
  });

  it("projects the newly captured send while an earlier dispatch is still awaiting admission", () => {
    const threadId = ThreadId.makeUnsafe("thread-preflight-successive-projection");
    const firstId = MessageId.makeUnsafe("first-pending-projection");
    const first = claimComposerSendPreflight(threadId, submission("first"))!;
    setComposerSendPreflightProjection(first, {
      id: firstId,
      role: "user",
      text: "first",
      createdAt: "2026-09-10T00:00:00.000Z",
      streaming: false,
    });
    markComposerSendPreflightDispatching(first, firstId, {
      ...submission("first"),
      messageId: firstId,
    });
    const next = claimComposerSendPreflight(threadId, submission("follow-up"))!;
    setComposerSendPreflightProjection(next, {
      id: MessageId.makeUnsafe("next-pending-projection"),
      role: "user",
      text: "follow-up",
      createdAt: "2026-09-10T00:00:01.000Z",
      streaming: false,
    });
    expect(getComposerSendPreflightProjection(threadId)?.text).toBe("follow-up");
    expect(getComposerDispatchedSendOwner(threadId)?.id).toBe(first.id);
    cancelComposerSendPreflight(threadId);
    expect(getComposerSendPreflightProjection(threadId)?.text).toBe("first");
  });

  it("keeps the dispatched Stop target addressable while a follow-up preparation exists", () => {
    const threadId = ThreadId.makeUnsafe("thread-preflight-multiple");
    const messageId = MessageId.makeUnsafe("message-preflight-original");
    const dispatched = claimComposerSendPreflight(threadId, submission("original"))!;
    markComposerSendPreflightDispatching(dispatched, messageId, {
      ...submission("original"),
      messageId,
    });
    claimComposerSendPreflight(threadId, submission("follow-up"));

    expect(getComposerDispatchedSendOwner(threadId)?.id).toBe(dispatched.id);
  });

  it("releases only the acknowledged dispatched message and preserves a follow-up owner", () => {
    const threadId = ThreadId.makeUnsafe("thread-preflight-ack");
    const messageId = MessageId.makeUnsafe("message-preflight-ack");
    const dispatched = claimComposerSendPreflight(threadId, submission("original"))!;
    markComposerSendPreflightDispatching(dispatched, messageId, {
      ...submission("original"),
      messageId,
    });
    const followUp = claimComposerSendPreflight(threadId, submission("follow-up"))!;

    markComposerSendPreflightAdmission(dispatched, 10);
    advanceComposerSendPreflightAppliedSequence(10);

    expect(getComposerDispatchedSendOwner(threadId)).toBeNull();
    expect(getComposerSendPreflight(threadId)?.id).toBe(followUp.id);
  });

  it("releases preflight ownership at admission while retaining exact visual activity", () => {
    const threadId = ThreadId.makeUnsafe("thread-preflight-visual");
    const messageId = MessageId.makeUnsafe("message-preflight-visual");
    const owner = claimComposerSendPreflight(threadId, submission("visual"))!;
    markComposerSendPreflightDispatching(owner, messageId, {
      ...submission("visual"),
      messageId,
    });

    markComposerSendPreflightAdmission(owner, 10);

    expect(getComposerDispatchedSendOwner(threadId)?.id).toBe(owner.id);
    expect(hasComposerSendActivity(threadId)).toBe(true);
    advanceComposerSendPreflightAppliedSequence(9);
    expect(hasComposerSendActivity(threadId)).toBe(true);
    advanceComposerSendPreflightAppliedSequence(10);
    expect(getComposerDispatchedSendOwner(threadId)).toBeNull();
    expect(hasComposerSendActivity(threadId)).toBe(false);
  });

  it("clears admitted activity when a reconnect snapshot covers its receipt", () => {
    const threadId = ThreadId.makeUnsafe("thread-preflight-global-ack");
    const messageId = MessageId.makeUnsafe("message-preflight-global-ack");
    const owner = claimComposerSendPreflight(threadId, submission("global acknowledgement"))!;
    markComposerSendPreflightDispatching(owner, messageId, {
      ...submission("global acknowledgement"),
      messageId,
    });
    markComposerSendPreflightAdmission(owner, 10);

    expect(hasComposerSendActivity(threadId)).toBe(true);
    // The message row can arrive in an earlier sync batch than turn-start-requested.
    // Only the final command frontier establishes the replacement work owner.
    expect(hasComposerSendActivity(threadId)).toBe(true);
    advanceComposerSendPreflightAppliedSequence(10);
    expect(hasComposerSendActivity(threadId)).toBe(false);
  });

  it("keeps the owner through receipt-before-projection and settles at applied frontier", () => {
    const threadId = ThreadId.makeUnsafe("thread-preflight-frontier-race");
    const messageId = MessageId.makeUnsafe("message-preflight-frontier-race");
    const owner = claimComposerSendPreflight(threadId, submission("frontier race"))!;
    markComposerSendPreflightDispatching(owner, messageId, {
      ...submission("frontier race"),
      messageId,
    });

    advanceComposerSendPreflightAppliedSequence(40);
    markComposerSendPreflightAdmission(owner, 42);
    // The message row can arrive in an earlier sync batch than turn-start-requested.
    // Only the final command frontier establishes the replacement work owner.
    expect(hasComposerSendActivity(threadId)).toBe(true);

    advanceComposerSendPreflightAppliedSequence(41);
    expect(hasComposerSendActivity(threadId)).toBe(true);
    advanceComposerSendPreflightAppliedSequence(42);
    expect(hasComposerSendActivity(threadId)).toBe(false);
  });
  it("settles immediately when projection arrived before the command receipt", () => {
    const threadId = ThreadId.makeUnsafe("thread-projection-before-receipt");
    const messageId = MessageId.makeUnsafe("message-projection-before-receipt");
    const owner = claimComposerSendPreflight(threadId, submission("already projected"))!;
    markComposerSendPreflightDispatching(owner, messageId, {
      ...submission("already projected"),
      messageId,
    });
    advanceComposerSendPreflightAppliedSequence(42);
    expect(hasComposerSendActivity(threadId)).toBe(true);
    markComposerSendPreflightAdmission(owner, 42);
    expect(hasComposerSendActivity(threadId)).toBe(false);
    advanceComposerSendPreflightAppliedSequence(41);
    expect(hasComposerSendActivity(threadId)).toBe(false);
  });

  it("does not resurrect a recovered message when its late admission receipt arrives", () => {
    const threadId = ThreadId.makeUnsafe("thread-late-receipt-after-recovery");
    const messageId = MessageId.makeUnsafe("message-late-receipt-after-recovery");
    const owner = claimComposerSendPreflight(threadId, submission("cancelled"))!;
    markComposerSendPreflightDispatching(owner, messageId, {
      ...submission("cancelled"),
      messageId,
    });
    settleComposerSendPreflightRecovery(threadId, messageId, 43);
    expect(hasComposerSendActivity(threadId)).toBe(false);
    markComposerSendPreflightAdmission(owner, 42);
    expect(hasComposerSendActivity(threadId)).toBe(false);
  });

  it("preserves the exact Stop owner through a remount before the receipt frontier applies", () => {
    const threadId = ThreadId.makeUnsafe("thread-preflight-remount");
    const messageId = MessageId.makeUnsafe("message-preflight-remount");
    const owner = claimComposerSendPreflight(threadId, submission("remount"))!;
    markComposerSendPreflightDispatching(owner, messageId, {
      ...submission("remount"),
      messageId,
    });
    advanceComposerSendPreflightAppliedSequence(40);
    markComposerSendPreflightAdmission(owner, 42);
    advanceComposerSendPreflightAppliedSequence(41);

    container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
    let hasPreflight = false;
    function Probe() {
      hasPreflight = useHasComposerSendPreflight(threadId);
      return null;
    }

    act(() => root?.render(createElement(Probe)));
    act(() => root?.unmount());
    root = createRoot(container);
    act(() => root?.render(createElement(Probe)));

    expect(hasComposerSendActivity(threadId)).toBe(true);
    expect(hasPreflight).toBe(true);
    expect(getComposerDispatchedSendOwner(threadId)?.messageId).toBe(messageId);
  });
});
