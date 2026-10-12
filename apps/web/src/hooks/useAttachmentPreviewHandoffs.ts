// FILE: useAttachmentPreviewHandoffs.ts
// Purpose: Own sent blob previews until their persisted transcript images commit.
// Layer: Web chat resource lifecycle.

import { useCallback, useEffect, useEffectEvent, useState } from "react";
import type { MessageId } from "@penkra/contracts";
import type { ChatMessage } from "../types";
import { revokeBlobPreviewUrl } from "../components/ChatView.logic";

function hasPersistedImages(message: ChatMessage): boolean {
  const images = message.attachments?.filter((attachment) => attachment.type === "image");
  return (
    images !== undefined &&
    images.length > 0 &&
    images.every((image) => {
      if (!image.previewUrl) return false;
      if (image.previewUrl.startsWith("/attachments/")) return true;
      try {
        return new URL(image.previewUrl).pathname.startsWith("/attachments/");
      } catch {
        return false;
      }
    })
  );
}

export function useAttachmentPreviewHandoffs({
  threadId,
  serverMessages,
  renderedMessages,
}: {
  threadId: string;
  serverMessages: readonly ChatMessage[];
  renderedMessages: readonly ChatMessage[];
}) {
  const [handoffs, setHandoffs] = useState<Record<string, readonly string[]>>({});
  const clearHandoffs = useEffectEvent(() => {
    for (const urls of Object.values(handoffs)) {
      for (const url of urls) revokeBlobPreviewUrl(url);
    }
    setHandoffs({});
  });
  useEffect(() => () => clearHandoffs(), [threadId]);

  useEffect(() => {
    const persistedIds = new Set(
      serverMessages.filter(hasPersistedImages).map((message) => message.id),
    );
    const renderedIds = new Set(
      renderedMessages.filter(hasPersistedImages).map((message) => message.id),
    );
    const finished = Object.keys(handoffs).filter(
      (id) => persistedIds.has(id as MessageId) && renderedIds.has(id as MessageId),
    );
    if (finished.length === 0) return;
    const remaining = { ...handoffs };
    for (const id of finished) {
      // This effect runs after the row using the persisted URL has committed.
      for (const url of handoffs[id]!) revokeBlobPreviewUrl(url);
      delete remaining[id];
    }
    setHandoffs(remaining);
  }, [handoffs, serverMessages, renderedMessages]);

  return useCallback((messageId: MessageId, urls: readonly string[]) => {
    if (urls.length === 0) return;
    setHandoffs((existing) => ({
      ...existing,
      [messageId]: [...new Set([...(existing[messageId] ?? []), ...urls])],
    }));
  }, []);
}
