// FILE: QueuedComposerTurnDispatcher.tsx
// Purpose: Drains persisted pre-runtime follow-ups independently of the visible thread route.
// Layer: Root orchestration coordinator

import { useEffect } from "react";
import { ThreadId } from "@penkra/contracts";

import { resolveAssistantDeliveryMode, useAppSettings } from "../appSettings";
import { useComposerDraftStore } from "../composerDraftStore";
import { dispatchQueuedComposerTurn } from "../lib/queuedComposerTurnDispatch";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { getThreadFromState } from "../threadDerivation";

const RETRY_DELAY_MS = 2_000;

export function QueuedComposerTurnDispatcher() {
  const { settings } = useAppSettings();
  const assistantDeliveryMode = resolveAssistantDeliveryMode(settings);

  useEffect(() => {
    let disposed = false;
    let scheduled = false;
    let retryTimer: number | null = null;
    const inFlightThreadIds = new Set<string>();

    const schedule = () => {
      if (disposed || scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        drain();
      });
    };

    const scheduleRetry = () => {
      if (disposed || retryTimer !== null) return;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        schedule();
      }, RETRY_DELAY_MS);
    };

    const drain = () => {
      const api = readNativeApi();
      if (!api) return;
      const drafts = useComposerDraftStore.getState().draftsByThreadId;
      const appState = useStore.getState();
      for (const [rawThreadId, draft] of Object.entries(drafts)) {
        const threadId = ThreadId.makeUnsafe(rawThreadId);
        const queuedTurn = draft.queuedTurns.find(
          (candidate) => candidate.serverAcceptedAt === undefined,
        );
        if (!queuedTurn || draft.queuePaused || inFlightThreadIds.has(rawThreadId)) continue;
        const thread = getThreadFromState(appState, threadId);
        if (!thread) continue;
        if (thread.hasPendingApprovals || thread.hasPendingUserInput) {
          continue;
        }

        inFlightThreadIds.add(rawThreadId);
        void dispatchQueuedComposerTurn({
          api,
          threadId: thread.id,
          queuedTurn,
          assistantDeliveryMode,
        })
          .then(() => {
            useComposerDraftStore
              .getState()
              .markQueuedTurnServerAccepted(thread.id, queuedTurn.id, new Date().toISOString());
            useStore.getState().setError(thread.id, null);
          })
          .catch((error: unknown) => {
            useStore
              .getState()
              .setError(
                thread.id,
                error instanceof Error ? error.message : "Failed to send queued message.",
              );
            scheduleRetry();
          })
          .finally(() => {
            inFlightThreadIds.delete(rawThreadId);
            schedule();
          });
      }
    };

    const unsubscribeDrafts = useComposerDraftStore.subscribe(schedule);
    const unsubscribeThreads = useStore.subscribe(schedule);
    schedule();
    return () => {
      disposed = true;
      unsubscribeDrafts();
      unsubscribeThreads();
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [assistantDeliveryMode]);

  return null;
}
