// Purpose: Share the thread-title rename flow between header and sidebar surfaces,
// including draft-thread promotion when a title is edited before the first send.
// The promotion path mirrors the first-send flow, but routes through the shared
// idempotent helper so concurrent draft promotion callers do not surface duplicate
// `thread.create` invariant failures as user-visible toasts.

import {
  type ModelSelection,
  type FolderId,
  type RuntimeMode,
  type SpaceId,
  type ThreadId,
} from "@penkra/contracts";
import { readNativeApi } from "../nativeApi";
import { promoteThreadCreate } from "./threadCreatePromotion";
import { newCommandId } from "./utils";

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
        workingDirectory: string | null;
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
        type: "thread.create",
        commandId: newCommandId(),
        threadId: input.threadId,
        folderId: input.createIfMissing.folderId,
        title: trimmed,
        modelSelection: input.createIfMissing.modelSelection,
        runtimeMode: input.createIfMissing.runtimeMode,
        workingDirectory: input.createIfMissing.workingDirectory,
        createdAt: input.createIfMissing.createdAt,
      },
      api,
    );
    if (promotionResult === "exists") {
      await api.orchestration.dispatchCommand({
        type: "thread.update",
        commandId: newCommandId(),
        threadId: input.threadId,
        title: trimmed,
      });
    }
  } else {
    await api.orchestration.dispatchCommand({
      type: "thread.update",
      commandId: newCommandId(),
      threadId: input.threadId,
      title: trimmed,
    });
  }

  return "renamed";
}
