// FILE: composerAssetStore.ts
// Purpose: Provides one durable binary store for composer images and files.
// Layer: Renderer storage adapter

import {
  deleteComposerImageBlob,
  persistComposerImageBlob,
  readComposerImageBlob,
} from "./composerImageBlobStore";

function desktopComposerDraftsBridge() {
  return typeof window !== "undefined" ? window.desktopBridge?.composerDrafts : undefined;
}

export async function persistComposerAsset(input: {
  threadId: string;
  assetId: string;
  file: File;
}): Promise<string> {
  const bridge = desktopComposerDraftsBridge();
  if (!bridge) {
    return persistComposerImageBlob({
      threadId: input.threadId,
      imageId: input.assetId,
      file: input.file,
    });
  }
  await bridge.writeAsset({
    id: input.assetId,
    draftId: input.threadId,
    name: input.file.name,
    mimeType: input.file.type || "application/octet-stream",
    bytes: new Uint8Array(await input.file.arrayBuffer()),
  });
  return input.assetId;
}

export async function readComposerAsset(input: {
  assetKey: string;
  name: string;
  mimeType: string;
}): Promise<File | null> {
  const bridge = desktopComposerDraftsBridge();
  if (!bridge) return readComposerImageBlob(input.assetKey);
  const bytes = await bridge.readAsset(input.assetKey);
  if (!bytes) return null;
  const body = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return new File([body], input.name, { type: input.mimeType });
}

export async function deleteComposerAsset(assetKey: string): Promise<void> {
  const bridge = desktopComposerDraftsBridge();
  if (bridge) {
    await bridge.deleteAsset(assetKey);
    return;
  }
  await deleteComposerImageBlob(assetKey);
}
