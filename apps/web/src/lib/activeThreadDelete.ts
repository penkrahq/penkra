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

// The terminal runtime pulls in xterm and its addons (~223 KB gzip). Importing it
// statically here anchored the whole terminal stack into the eager sidebar/router
// graph, so every page load paid for it. Deleting a thread is a rare, already
// async user action, so the chunk is fetched on demand instead. The import is
// awaited (never fire-and-forget) so disposal cannot race the rest of the delete
// sequence, and the resolved module is cached by the module system afterwards.
async function disposeThreadTerminalRuntimes(threadId: ThreadId): Promise<void> {
  try {
    const { terminalRuntimeRegistry } =
      await import("../components/terminal/terminalRuntimeRegistry");
    terminalRuntimeRegistry.disposeThread(threadId);
  } catch (error) {
    // A failed chunk fetch must not abort the delete sequence: the durable delete
    // already landed server-side and the server owns provider/terminal teardown.
    console.error("Failed to dispose terminal runtimes for deleted thread", { threadId, error });
  }
}

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
  await api.orchestration.dispatchCommand({
    type: "thread.delete",
    commandId: newCommandId(),
    threadId: input.threadId,
  });
  // Provider and terminal cleanup are owned by the server-side lifecycle
  // reactor. Dispose only the local renderer after the durable delete intent
  // was accepted, so a rejected delete never tears down a live client session.
  await disposeThreadTerminalRuntimes(input.threadId);
  if (input.reconcileDeletedThread ?? true) {
    void reconcileDeletedThreadFromClient({
      threadId: input.threadId,
      removeDeletedThreadFromClientState: useStore.getState().removeDeletedThreadFromClientState,
    });
  }
  await input.onDeleted({ thread, prepared });
}
