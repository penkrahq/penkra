// FILE: _chat.$threadId.tsx
// Purpose: Resolve the active thread route into a single chat surface.
// Layer: Route container

import { type FolderId, ThreadId, singletonThreadDeckId } from "@penkra/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { parseChatRouteSearch } from "../chatRouteSearch";
import { isLocalThreadArchiveNavigationPending } from "../lib/threadArchiveNavigation";
import { useStore } from "../store";
import { createThreadExistsSelector, createThreadFolderIdSelector } from "../storeSelectors";
import { SingleChatSurface } from "../components/chat/SingleChatSurface";
import { resolveSingleFolderId, shouldRedirectArchivedThreadRoute } from "./-chatThreadRoute.logic";

function ChatThreadRouteView() {
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const threadId = Route.useParams({
    select: (params) => ThreadId.makeUnsafe(params.threadId),
  });
  const threadFolderIdSelector = createThreadFolderIdSelector(threadId);
  const threadExistsSelector = createThreadExistsSelector(threadId);
  const threadFolderId: FolderId | null = useStore(threadFolderIdSelector);
  const threadExists = useStore(threadExistsSelector);
  const threadArchived = useStore((store) => store.threadShellById?.[threadId]?.archivedAt != null);
  const persistedDeckId = useStore((store) => store.threadShellById?.[threadId]?.deckId ?? null);
  const draftThreadState = useComposerDraftStore(
    (store) => store.draftThreadsByThreadId[threadId] ?? null,
  );
  const draftThreadExists = draftThreadState !== null;
  const routeThreadExists = threadExists || draftThreadExists;
  const homeDeckId = persistedDeckId ?? draftThreadState?.deckId ?? singletonThreadDeckId(threadId);
  const activeFolderId = resolveSingleFolderId({
    threadFolderId,
    draftFolderId: draftThreadState?.folderId ?? null,
  });
  const navigate = useNavigate();
  useEffect(() => {
    const home = window.desktopBridge?.threadHome;
    if (!routeThreadExists || threadArchived) {
      home?.leave();
      return;
    }
    const recordView = () => {
      const visibleThreadIds = [threadId];
      const activeThreadId = threadId;
      const state = useStore.getState();
      const draftState = useComposerDraftStore.getState();
      const views = visibleThreadIds.map((visibleThreadId) => ({
        threadId: visibleThreadId,
        deckId:
          state.threadShellById?.[visibleThreadId]?.deckId ??
          draftState.draftThreadsByThreadId[visibleThreadId]?.deckId ??
          (visibleThreadId === threadId ? homeDeckId : singletonThreadDeckId(visibleThreadId)),
      }));
      home?.view({ views, activeThreadId });
    };
    recordView();
    window.addEventListener("focus", recordView);
    return () => window.removeEventListener("focus", recordView);
  }, [homeDeckId, routeThreadExists, threadArchived, threadId]);

  useEffect(() => {
    const home = window.desktopBridge?.threadHome;
    return () => home?.leave();
  }, [threadId]);

  useEffect(() => {
    if (!threadsHydrated) {
      return;
    }

    if (threadArchived) {
      if (
        shouldRedirectArchivedThreadRoute({
          archived: true,
          localArchiveNavigationPending: isLocalThreadArchiveNavigationPending(threadId),
        })
      ) {
        void navigate({ to: "/", replace: true });
      }
      return;
    }

    if (!routeThreadExists) {
      void navigate({ to: "/", replace: true });
    }
  }, [navigate, routeThreadExists, threadId, threadArchived, threadsHydrated]);

  if (threadArchived) {
    return null;
  }

  if (!threadsHydrated) {
    return null;
  }

  if (!routeThreadExists) {
    return null;
  }

  return <SingleChatSurface threadId={threadId} folderId={activeFolderId} />;
}

export const Route = createFileRoute("/_chat/$threadId")({
  validateSearch: (search) => parseChatRouteSearch(search),
  component: ChatThreadRouteView,
});
