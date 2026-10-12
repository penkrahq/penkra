// FILE: activeThreadDelete.ts
// Purpose: Owns the shared server-delete sequence for active threads.
// Layer: Web orchestration helper
// Exports: deleteActiveThreadFromClient

import type { ThreadId } from "@penkra/contracts";

import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { getThreadFromState } from "../threadDerivation";
import type { Thread } from "../types";
import { reconcileDeletedThreadFromClient } from "./deletedThreadClientReconciliation";
import { newCommandId } from "./utils";

export async function deleteActiveThreadFromClient<TPrepared = undefined>(input: {
  readonly threadId: ThreadId;
  readonly reconcileDeletedThread?: boolean;
  readonly prepareForDelete?: (thread: Thread) => TPrepared;
  readonly onDeleted: (input: {
    thread: Thread;
    prepared: TPrepared | undefined;
  }) => void | Promise<void>;
}): Promise<void> {
  const api = readNativeApi();
  if (!api) return;
  const state = useStore.getState();
  const thread = getThreadFromState(state, input.threadId);
  if (!thread) return;
  const prepared = input.prepareForDelete?.(thread);
  await api.cleanCore.updateThread({
    update: {
      action: "delete",
      threadId: input.threadId,
      deletedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  });
  if (input.reconcileDeletedThread ?? true) {
    void reconcileDeletedThreadFromClient({
      threadId: input.threadId,
      removeDeletedThreadFromClientState: useStore.getState().removeDeletedThreadFromClientState,
    });
  }
  await input.onDeleted({ thread, prepared });
}
