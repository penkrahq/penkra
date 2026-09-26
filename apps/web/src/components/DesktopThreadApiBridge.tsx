// FILE: DesktopThreadApiBridge.tsx
// Purpose: Project shell Thread state to hosted Apps; commands execute in the backend.

import type { AppThreadState } from "@penkra/sdk";
import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ThreadId } from "@penkra/contracts";

import { useComposerDraftStore } from "../composerDraftStore";
import {
  getDesktopThreadLiveHandlers,
  subscribeDesktopThreadLiveStateChanges,
} from "../desktopThreadApiBroker";
import { deriveUnmountedThreadLiveState } from "../lib/desktopThreadState";
import { useStore } from "../store";

function deckStates(deckId: string): ReadonlyArray<AppThreadState> {
  const state = useStore.getState();
  const deck = state.decks.find((candidate) => candidate.id === deckId);
  if (!deck) return [];
  const drafts = useComposerDraftStore.getState().draftsByThreadId;
  const queuedCountForThread = (threadId: ThreadId) =>
    state.threadTurnStateById?.[threadId]?.queuedMessageIds?.length ?? 0;
  return deck.threadIds.flatMap((threadId) => {
    const shell = state.threadShellById?.[threadId];
    if (!shell) return [];
    const draft = drafts[threadId];
    const live =
      getDesktopThreadLiveHandlers(threadId)?.read() ??
      deriveUnmountedThreadLiveState(
        threadId,
        state.sidebarThreadSummaryById[threadId],
        queuedCountForThread(threadId),
      );
    const hasDraft =
      !!draft &&
      Boolean(
        draft.prompt ||
        draft.files.length ||
        draft.images.length ||
        draft.pastedTexts.length ||
        draft.skills.length,
      );
    return [
      {
        threadId,
        deckId: shell.deckId,
        title: shell.title,
        order: shell.deckSortOrder,
        archived: shell.archivedAt != null,
        phase:
          live?.phase ??
          (shell.hasPendingUserInput
            ? "waiting"
            : shell.workStatus === "running"
              ? "running"
              : "idle"),
        activeTurnId:
          live?.activeTurnId ?? state.threadSessionById?.[threadId]?.activeTurnId ?? null,
        pendingQuestion: live?.pendingUserInput ?? shell.hasPendingUserInput === true,
        composer: {
          empty: !hasDraft,
          owner: hasDraft ? ("human" as const) : ("none" as const),
          composeId: null,
        },
        queued: {
          count: live?.queuedCount ?? queuedCountForThread(threadId),
          hasAppSubmission: false,
        },
        steering: { pending: live?.steeringPending ?? false, hasAppSubmission: false },
        updatedAt: shell.updatedAt ?? "1970-01-01T00:00:00.000Z",
      },
    ];
  });
}

export function DesktopThreadApiBridge() {
  const navigate = useNavigate();
  useEffect(
    () =>
      window.desktopBridge?.threadHome?.onSelect(({ threadId }) => {
        void navigate({
          to: "/$threadId",
          params: { threadId: ThreadId.makeUnsafe(threadId) },
          search: (previous) => ({ ...previous, splitViewId: undefined }),
        });
      }),
    [navigate],
  );
  useEffect(() => {
    const bridge = window.desktopBridge?.threadApi;
    if (!bridge) return;
    let disposed = false;
    let scheduled = false;
    const fingerprints = new Map<string, string>();
    const publish = () => {
      scheduled = false;
      if (disposed) return;
      for (const deck of useStore.getState().decks) {
        const threads = deckStates(deck.id);
        const fingerprint = JSON.stringify(threads);
        if (fingerprints.get(deck.id) === fingerprint) continue;
        fingerprints.set(deck.id, fingerprint);
        bridge.publishState({ spaceId: deck.spaceId, deckId: deck.id, threads });
      }
    };
    const schedule = () => {
      if (scheduled || disposed) return;
      scheduled = true;
      queueMicrotask(publish);
    };
    const unsubscribeStore = useStore.subscribe(schedule);
    const unsubscribeDrafts = useComposerDraftStore.subscribe(schedule);
    const unsubscribeLive = subscribeDesktopThreadLiveStateChanges(schedule);
    schedule();
    return () => {
      disposed = true;
      unsubscribeStore();
      unsubscribeDrafts();
      unsubscribeLive();
    };
  }, []);
  return null;
}
