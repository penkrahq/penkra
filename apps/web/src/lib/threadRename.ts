// Purpose: Rename an existing server thread through the clean-core writer.

import type { ThreadId } from "@penkra/contracts";
import { readNativeApi } from "../nativeApi";

type ThreadRenameOutcome = "empty" | "unchanged" | "unavailable" | "renamed";

export async function dispatchThreadRename(input: {
  threadId: ThreadId;
  newTitle: string;
  unchangedTitles: readonly string[];
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

  await api.cleanCore.updateThread({
    update: {
      action: "rename",
      threadId: input.threadId,
      title: trimmed,
      updatedAt: new Date().toISOString(),
    },
  });

  return "renamed";
}
