// FILE: QueuedComposerTurnDispatcher.tsx
// Purpose: Drains persisted pre-runtime follow-ups independently of the visible thread route.
// Layer: Root orchestration coordinator

import { useEffect } from "react";
import { ThreadId } from "@penkra/contracts";

import { resolveAssistantDeliveryMode, useAppSettings } from "../appSettings";
import { useComposerDraftStore } from "../composerDraftStore";
import {
  dispatchQueuedComposerTurn,
  isQueuedComposerBindingRevisionError,
} from "../lib/queuedComposerTurnDispatch";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { getThreadFromState } from "../threadDerivation";

const RETRY_DELAY_MS = 2_000;
const MAX_RETRY_DELAY_MS = 30_000;

export function queuedComposerTurnRetryDelayMs(previousAttempts: number): number {
  const attempt = Math.max(0, Math.floor(previousAttempts));
  return Math.min(RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
}

export function QueuedComposerTurnDispatcher() {
  const { settings } = useAppSettings();
  const assistantDeliveryMode = resolveAssistantDeliveryMode(settings);

  useEffect(() => {
    let disposed = false;
    let scheduled = false;
    const inFlightThreadIds = new Set<string>();
    const retryAttemptsByThreadId = new Map<string, number>();
    const retryTimersByThreadId = new Map<string, number>();

    const schedule = () => {
      if (disposed || scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        drain();
      });
    };

    const scheduleRetry = (threadId: string) => {
      if (disposed || retryTimersByThreadId.has(threadId)) return;
      const previousAttempts = retryAttemptsByThreadId.get(threadId) ?? 0;
      retryAttemptsByThreadId.set(threadId, previousAttempts + 1);
      const retryTimer = window.setTimeout(() => {
        retryTimersByThreadId.delete(threadId);
        schedule();
      }, queuedComposerTurnRetryDelayMs(previousAttempts));
      retryTimersByThreadId.set(threadId, retryTimer);
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
        if (
          !queuedTurn ||
          draft.queuePaused ||
          inFlightThreadIds.has(rawThreadId) ||
          retryTimersByThreadId.has(rawThreadId)
        ) {
          continue;
        }
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
          persistDispatchAdmission: (attempt, bindingRevision) =>
            useComposerDraftStore
              .getState()
              .setQueuedTurnDispatchAdmission(thread.id, queuedTurn.id, attempt, bindingRevision),
        })
          .then(() => {
            useComposerDraftStore
              .getState()
              .markQueuedTurnServerAccepted(thread.id, queuedTurn.id, new Date().toISOString());
            useStore.getState().setError(thread.id, null);
            retryAttemptsByThreadId.delete(rawThreadId);
          })
          .catch((error: unknown) => {
            if (isQueuedComposerBindingRevisionError(error)) {
              useComposerDraftStore
                .getState()
                .advanceQueuedTurnDispatchAttempt(thread.id, queuedTurn.id);
            }
            useStore
              .getState()
              .setError(
                thread.id,
                error instanceof Error ? error.message : "Failed to send queued message.",
              );
            scheduleRetry(rawThreadId);
          })
          .finally(() => {
            inFlightThreadIds.delete(rawThreadId);
            // Failed turns remain blocked by their retry timer. Successful turns
            // drain immediately so the next accepted item can start.
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
      for (const retryTimer of retryTimersByThreadId.values()) {
        window.clearTimeout(retryTimer);
      }
      retryTimersByThreadId.clear();
      retryAttemptsByThreadId.clear();
    };
  }, [assistantDeliveryMode]);

  return null;
}
