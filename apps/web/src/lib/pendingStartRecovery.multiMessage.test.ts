import { MessageId, ThreadId } from "@penkra/contracts";
import { describe, expect, it } from "vitest";
import type { PendingStartRecovery, PendingStartRecoveryRecord } from "../composerDraftStore";
import { partializeComposerDraftStoreState, useComposerDraftStore } from "../composerDraftStore";
import { makeQueuedChatTurn, resetComposerDraftStore } from "../composerDraftStoreTestFixtures";
import { toHydratedThreadDraft } from "../composerDraftPersistence";

describe("pending recovery durable identity RED", () => {
  it("retains two distinct unresolved messages across capture and settlement", () => {
    resetComposerDraftStore();
    const threadId = ThreadId.makeUnsafe("thread-two-pending-red");
    const firstMessageId = MessageId.makeUnsafe("message-first-pending-red");
    const secondMessageId = MessageId.makeUnsafe("message-second-pending-red");
    const recovery = (messageId: MessageId, prompt: string): PendingStartRecovery => ({
      schemaVersion: 1,
      threadId,
      messageId,
      pendingTurn: {
        ...makeQueuedChatTurn(messageId),
        id: messageId,
        prompt,
        previewText: prompt,
      },
      settlement: "unresolved",
    });
    const store = useComposerDraftStore.getState();

    expect(store.capturePendingStartRecovery(threadId, recovery(firstMessageId, "first"))).toBe(
      true,
    );
    expect(store.capturePendingStartRecovery(threadId, recovery(secondMessageId, "second"))).toBe(
      true,
    );

    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(Object.keys(draft?.pendingStartRecoveriesByMessageId ?? {})).toEqual([
      firstMessageId,
      secondMessageId,
    ]);

    expect(store.markPendingStartRecoveryAccepted(threadId, firstMessageId, 10)).toBe(true);
    expect(
      store.restorePendingStartRecovery(threadId, secondMessageId, 11, "2026-09-07T00:00:00Z"),
    ).toBe(true);
    const settled = useComposerDraftStore.getState().draftsByThreadId[threadId]!;
    const settledRecoveries = settled.pendingStartRecoveriesByMessageId ?? {};
    expect(settledRecoveries[firstMessageId]).toMatchObject({
      settlement: "accepted",
      receiptSequence: 10,
    });
    expect(settledRecoveries[secondMessageId]).toMatchObject({
      settlement: "restored",
      restorationReceipt: { sequence: 11, rowId: "composer" },
    });

    const persisted = partializeComposerDraftStoreState(useComposerDraftStore.getState());
    const reloaded = toHydratedThreadDraft(threadId, persisted.draftsByThreadId[threadId]!);
    expect(Object.keys(reloaded.pendingStartRecoveriesByMessageId ?? {})).toEqual([
      firstMessageId,
      secondMessageId,
    ]);

    const unknownMessageId = MessageId.makeUnsafe("message-unknown-pending-red");
    const unknownRecord: PendingStartRecoveryRecord = {
      schemaVersion: 99,
      threadId,
      messageId: unknownMessageId,
      raw: { schemaVersion: 99, messageId: unknownMessageId, payload: "retain" },
    };
    useComposerDraftStore.setState((state) => ({
      draftsByThreadId: {
        ...state.draftsByThreadId,
        [threadId]: {
          ...state.draftsByThreadId[threadId]!,
          pendingStartRecoveriesByMessageId: {
            ...state.draftsByThreadId[threadId]!.pendingStartRecoveriesByMessageId,
            [unknownMessageId]: unknownRecord,
          },
        },
      },
    }));
    expect(
      store.capturePendingStartRecovery(threadId, recovery(unknownMessageId, "overwrite")),
    ).toBe(false);
    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]!
        .pendingStartRecoveriesByMessageId?.[unknownMessageId],
    ).toEqual(unknownRecord);
  });

  it("retains an exact failed record for retry when cleanup persistence rejects", async () => {
    resetComposerDraftStore();
    const threadId = ThreadId.makeUnsafe("thread-failed-retry-green");
    const messageId = MessageId.makeUnsafe("message-failed-retry-green");
    const recovery: PendingStartRecovery = {
      schemaVersion: 1,
      threadId,
      messageId,
      pendingTurn: {
        ...makeQueuedChatTurn(messageId),
        id: messageId,
        prompt: "preserve failed payload",
        previewText: "preserve failed payload",
      },
      settlement: "unresolved",
    };
    const store = useComposerDraftStore.getState();
    expect(store.capturePendingStartRecovery(threadId, recovery)).toBe(true);
    store.setPrompt(threadId, "newer draft survives retry");

    let rejectCleanup = true;
    const settleFailed = async () => {
      expect(
        useComposerDraftStore.getState().markPendingStartRecoveryFailed(threadId, messageId),
      ).toBe(true);
      if (rejectCleanup) {
        rejectCleanup = false;
        throw new Error("controlled cleanup write rejection");
      }
      expect(useComposerDraftStore.getState().clearPendingStartRecovery(threadId, messageId)).toBe(
        true,
      );
    };

    await expect(settleFailed()).rejects.toThrow("controlled cleanup write rejection");
    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]
        ?.pendingStartRecoveriesByMessageId?.[messageId],
    ).toMatchObject({ settlement: "failed", pendingTurn: { prompt: "preserve failed payload" } });
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe(
      "newer draft survives retry",
    );

    await settleFailed();
    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]
        ?.pendingStartRecoveriesByMessageId?.[messageId],
    ).toBeUndefined();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe(
      "newer draft survives retry",
    );
  });
});
