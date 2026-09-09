import { MessageId, ThreadId } from "@penkra/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { makeQueuedChatTurn } from "./composerDraftStoreTestFixtures";

const submission = (prompt: string) => ({ ...makeQueuedChatTurn(prompt), prompt });

import {
  cancelComposerSendPreflight,
  claimComposerSendPreflight,
  getComposerSendPreflight,
  getComposerDispatchedSendOwner,
  hasComposerSendActivity,
  markComposerSendPreflightDispatching,
  releaseComposerSendPreflight,
  releaseComposerSendPreflightAfterAdmission,
  releaseComposerSendPreflightForMessage,
  resetComposerSendPreflightsForTests,
} from "./composerSendPreflight";

describe("composerSendPreflight", () => {
  beforeEach(resetComposerSendPreflightsForTests);

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

    releaseComposerSendPreflightForMessage(threadId, messageId);

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

    releaseComposerSendPreflightAfterAdmission(owner);

    expect(getComposerSendPreflight(threadId)).toBeNull();
    expect(hasComposerSendActivity(threadId)).toBe(true);
    releaseComposerSendPreflightForMessage(threadId, messageId);
    expect(hasComposerSendActivity(threadId)).toBe(false);
  });
});
