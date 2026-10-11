// Purpose: Share the thread-title rename flow between header and sidebar surfaces,
// including draft-thread promotion when a title is edited before the first send.
// The promotion path mirrors the first-send flow, but routes through the shared
// idempotent helper so concurrent draft promotion callers do not surface duplicate
// creation failures as user-visible toasts.

import {
  type ModelSelection,
  type FolderId,
  type RuntimeMode,
  type SpaceId,
  type ThreadId,
} from "@penkra/contracts";
import { readNativeApi } from "../nativeApi";
import { promoteThreadCreate } from "./threadCreatePromotion";

type ThreadRenameOutcome = "empty" | "unchanged" | "unavailable" | "renamed";

export async function dispatchThreadRename(input: {
  threadId: ThreadId;
  newTitle: string;
  unchangedTitles: readonly string[];
  createIfMissing?:
    | {
        folderId: FolderId;
        spaceId?: SpaceId | null;
        modelSelection: ModelSelection;
        runtimeMode: RuntimeMode;
        createdAt: string;
      }
    | undefined;
}): Promise<ThreadRenameOutcome> {
  const trimmed = input.newTitle.trim();
  if (trimmed.length === 0) {
    return "empty";
  }
  if (input.unchangedTitles.includes(trimmed)) {
    return "unchanged";
  }

  const api = readNativeApi();
  if (!api) {
    return "unavailable";
  }

  if (input.createIfMissing) {
    const promotionResult = await promoteThreadCreate(
      {
        creator: { kind: "user" },
        connection: { kind: "default" },
        threadId: input.threadId,
        folderId: input.createIfMissing.folderId,
        title: trimmed,
        modelSelection: input.createIfMissing.modelSelection,
        runtimeMode: input.createIfMissing.runtimeMode,
        createdAt: input.createIfMissing.createdAt,
      },
      api,
    );
    if (promotionResult === "exists") {
      await api.cleanCore.updateThread({
        update: {
          action: "rename",
          threadId: input.threadId,
          title: trimmed,
          updatedAt: new Date().toISOString(),
        },
      });
    }
  } else {
    await api.cleanCore.updateThread({
      update: {
        action: "rename",
        threadId: input.threadId,
        title: trimmed,
        updatedAt: new Date().toISOString(),
      },
    });
  }

  return "renamed";
}
