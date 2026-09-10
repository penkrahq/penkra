import { MessageId, ThreadId } from "@penkra/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  COMPOSER_DRAFT_STORAGE_KEY,
  COMPOSER_DRAFT_STORAGE_VERSION,
  createEmptyThreadDraft,
  type PendingStartRecovery,
} from "../composerDraftDomain";
import {
  normalizeCurrentPersistedComposerDraftStoreState,
  partializeComposerDraftStoreState,
  toHydratedThreadDraft,
} from "../composerDraftPersistence";
import { useComposerDraftStore } from "../composerDraftStore";
import {
  makeFile,
  makeImage,
  makeQueuedChatTurn,
  resetComposerDraftStore,
} from "../composerDraftStoreTestFixtures";
import { persistComposerAsset, readComposerAsset } from "./composerAssetStore";
import { createDeferredPersistStorage } from "./storage";

describe("pending recovery durable restart controls", () => {
  it("transfers file and image asset ownership from the composer through recovery settlement", async () => {
    resetComposerDraftStore();
    const threadId = ThreadId.makeUnsafe("thread-recovery-assets-green");
    const messageId = MessageId.makeUnsafe("message-recovery-assets-green");
    const file = {
      ...makeFile({ id: "file-recovery-green" }),
      assetKey: "file-asset-recovery-green",
    };
    const image = makeImage({
      id: "image-recovery-green",
      previewUrl: "data:image/png;base64,AQ==",
    });
    const imageAsset = "image-asset-recovery-green";
    const assetBytes = new Map<string, Uint8Array>();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        desktopBridge: {
          composerDrafts: {
            writeAsset: async ({ id, bytes }: { id: string; bytes: Uint8Array }) => {
              assetBytes.set(id, bytes);
            },
            readAsset: async (id: string) => assetBytes.get(id) ?? null,
            deleteAsset: async (id: string) => {
              assetBytes.delete(id);
            },
          },
        },
      },
    });
    await persistComposerAsset({ threadId, assetId: file.assetKey, file: file.file });
    await persistComposerAsset({ threadId, assetId: imageAsset, file: image.file });
    const recovery: PendingStartRecovery = {
      schemaVersion: 1,
      threadId,
      messageId,
      pendingTurn: {
        ...makeQueuedChatTurn(messageId),
        id: messageId,
        files: [file],
        images: [image],
        messageId,
      },
      persistedImages: [
        {
          id: image.id,
          name: image.name,
          mimeType: image.mimeType,
          sizeBytes: image.sizeBytes,
          blobKey: imageAsset,
        },
      ],
      settlement: "unresolved",
    };
    const store = useComposerDraftStore.getState();
    store.addFiles(threadId, [file]);
    useComposerDraftStore.setState((state) => ({
      draftsByThreadId: {
        ...state.draftsByThreadId,
        [threadId]: {
          ...state.draftsByThreadId[threadId]!,
          images: [image],
          persistedAttachments: recovery.persistedImages!,
        },
      },
    }));
    store.clearComposerContent(threadId, { preservePersistedAssets: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(
      await readComposerAsset({
        assetKey: file.assetKey,
        name: file.name,
        mimeType: file.mimeType,
      }),
    ).not.toBeNull();
    expect(
      await readComposerAsset({
        assetKey: imageAsset,
        name: image.name,
        mimeType: image.mimeType,
      }),
    ).not.toBeNull();
    expect(store.capturePendingStartRecovery(threadId, recovery)).toBe(true);
    expect(store.markPendingStartRecoveryAccepted(threadId, messageId, 1)).toBe(true);
    expect(store.clearPendingStartRecovery(threadId, messageId)).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(
      await readComposerAsset({
        assetKey: file.assetKey,
        name: file.name,
        mimeType: file.mimeType,
      }),
    ).toBeNull();
    expect(
      await readComposerAsset({
        assetKey: imageAsset,
        name: image.name,
        mimeType: image.mimeType,
      }),
    ).toBeNull();
  });

  it("rehydrates per-message payloads after module restart and settles each identity once", async () => {
    const threadId = ThreadId.makeUnsafe("thread-restart-green");
    const acceptedId = MessageId.makeUnsafe("message-accepted-restart-green");
    const cancelledId = MessageId.makeUnsafe("message-cancelled-restart-green");
    const unknownId = MessageId.makeUnsafe("message-unknown-restart-green");
    const recovery = (messageId: MessageId, prompt: string): PendingStartRecovery => ({
      schemaVersion: 1,
      threadId,
      messageId,
      pendingTurn: {
        ...makeQueuedChatTurn(messageId),
        id: messageId,
        prompt,
        previewText: prompt,
        messageId,
      },
      settlement: "unresolved",
    });
    const state = {
      draftsByThreadId: {
        [threadId]: {
          ...createEmptyThreadDraft(),
          pendingStartRecoveriesByMessageId: {
            [acceptedId]: recovery(acceptedId, "accepted payload"),
            [cancelledId]: recovery(cancelledId, "cancelled payload"),
            [unknownId]: {
              schemaVersion: 99,
              threadId,
              messageId: unknownId,
              raw: { schemaVersion: 99, messageId: unknownId, payload: "retain" },
            },
          },
        },
      },
      draftThreadsByThreadId: {},
      projectDraftThreadIdByFolderId: {},
      stickyModelSelectionByProvider: {},
      stickyConnectionByProvider: {},
      stickyActiveProvider: null,
    };
    const bytes = new Map<string, string>();
    const storage = createDeferredPersistStorage({
      getStorage: () => ({
        getItem: (name: string) => bytes.get(name) ?? null,
        setItem: (name: string, value: string) => bytes.set(name, value),
        removeItem: (name: string) => bytes.delete(name),
      }),
      partialize: partializeComposerDraftStoreState,
      debounceMs: 0,
    });
    storage.setItem(COMPOSER_DRAFT_STORAGE_KEY, {
      state: state as never,
      version: COMPOSER_DRAFT_STORAGE_VERSION,
    });
    storage.flush();
    const durable = JSON.parse(bytes.get(COMPOSER_DRAFT_STORAGE_KEY)!);
    const normalized = normalizeCurrentPersistedComposerDraftStoreState(durable.state);
    const hydrated = toHydratedThreadDraft(threadId, normalized.draftsByThreadId[threadId]!);
    const hydratedRecoveries = hydrated.pendingStartRecoveriesByMessageId ?? {};
    expect(Object.keys(hydratedRecoveries)).toEqual([acceptedId, cancelledId, unknownId]);

    vi.resetModules();
    const { PendingStartRecoveryRegistry } = await import("./pendingStartRecoveryRegistry");
    const registry = new PendingStartRecoveryRegistry<{
      threadId: ThreadId;
      messageId: MessageId;
      previewUrls: readonly string[];
      restore: () => Promise<void>;
    }>();
    const accepted = vi.fn(async () => {});
    const cancelled = vi.fn(async () => {});
    for (const record of Object.values(hydratedRecoveries)) {
      if (!record || "raw" in record) continue;
      registry.register({
        threadId,
        messageId: record.messageId,
        previewUrls: record.pendingTurn.images.map((image) => image.previewUrl),
        restore: cancelled,
      });
    }
    await registry.request({
      threadId,
      messageId: acceptedId,
      minimumSequence: 10,
      lookup: async () => ({
        threadId,
        messageId: acceptedId,
        snapshotSequence: 10,
        threadExists: true,
        outcome: "accepted" as const,
      }),
      restoreCancelled: cancelled,
      accept: async () => accepted(),
    });
    await registry.request({
      threadId,
      messageId: cancelledId,
      minimumSequence: 11,
      lookup: async () => ({
        threadId,
        messageId: cancelledId,
        snapshotSequence: 11,
        threadExists: false,
        outcome: "unknown" as const,
      }),
      restoreCancelled: cancelled,
    });
    expect(registry.get(threadId, cancelledId)?.messageId).toBe(cancelledId);
    await registry.request({
      threadId,
      messageId: cancelledId,
      minimumSequence: 12,
      lookup: async () => ({
        threadId,
        messageId: cancelledId,
        snapshotSequence: 12,
        threadExists: true,
        outcome: "cancelled" as const,
      }),
      restoreCancelled: cancelled,
    });
    await registry.request({
      threadId,
      messageId: unknownId,
      minimumSequence: 13,
      lookup: async () => ({
        threadId,
        messageId: unknownId,
        snapshotSequence: 13,
        threadExists: false,
        outcome: "unknown" as const,
      }),
      restoreCancelled: cancelled,
    });

    expect(accepted).toHaveBeenCalledTimes(1);
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(registry.get(threadId, acceptedId)).toBeUndefined();
    expect(registry.get(threadId, cancelledId)).toBeUndefined();
    expect(registry.get(threadId, unknownId)).toBeUndefined();
    expect(hydratedRecoveries[unknownId]).toMatchObject({
      schemaVersion: 99,
      messageId: unknownId,
    });
  });
});
