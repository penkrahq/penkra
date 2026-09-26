import { MessageId, ThreadId } from "@penkra/contracts";
import { describe, expect, it } from "vitest";
import { type PendingStartRecovery } from "../composerDraftDomain";
import { useComposerDraftStore } from "../composerDraftStore";
import {
  makeFile,
  makeImage,
  makeQueuedChatTurn,
  resetComposerDraftStore,
} from "../composerDraftStoreTestFixtures";
import { persistComposerAsset, readComposerAsset } from "./composerAssetStore";

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
});
