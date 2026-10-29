import { useP29LayoutTrace } from "../lib/p29LayoutTrace";
// FILE: _chat.$threadId.tsx
// Purpose: Resolve the active thread route into a single chat surface.
// Layer: Route container

import { ThreadId } from "@penkra/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { parseChatRouteSearch } from "../chatRouteSearch";
import { isLocalThreadArchiveNavigationPending } from "../lib/threadArchiveNavigation";
import { useStore } from "../store";
import { loadThread, useThreadSummary } from "../threadListStore";
import { toastManager } from "../components/ui/toast";
import { SingleChatSurface } from "../components/chat/SingleChatSurface";
import { resolveSingleFolderId, shouldRedirectArchivedThreadRoute } from "./-chatThreadRoute.logic";

function ChatThreadRouteView() {
  const startupHydrated = useStore((store) => store.startupHydrated);
  const threadId = Route.useParams({
    select: (params) => ThreadId.make(params.threadId),
  });
  const thread = useThreadSummary(threadId);
  const threadFolderId = thread?.folderId ?? null;
  const threadArchived = thread !== null && thread.archivedAt !== null;
  const threadDeleted = thread !== null && thread.deletedAt !== null;
  const readsByThreadId = useRef(new Map<ThreadId, ReturnType<typeof loadThread>>());
  const draftThreadState = useComposerDraftStore(
    (store) => store.draftThreadsByThreadId[threadId] ?? null,
  );
  const draftThreadExists = draftThreadState !== null;
  const routeThreadExists = thread !== null || draftThreadExists;
  const activeFolderId = resolveSingleFolderId({
    threadFolderId,
    draftFolderId: draftThreadState?.folderId ?? null,
  });
  const navigate = useNavigate();
  useEffect(() => {
    const home = window.desktopBridge?.threadHome;
    if (!routeThreadExists || threadArchived || threadDeleted || activeFolderId === null) {
      home?.leave();
      return;
    }
    const recordView = () => {
      home?.view({ views: [{ threadId, folderId: activeFolderId }], activeThreadId: threadId });
    };
    recordView();
    window.addEventListener("focus", recordView);
    return () => window.removeEventListener("focus", recordView);
  }, [activeFolderId, routeThreadExists, threadArchived, threadDeleted, threadId]);

  useEffect(() => {
    const home = window.desktopBridge?.threadHome;
    return () => home?.leave();
  }, [threadId]);

  useEffect(() => {
    if (!startupHydrated) {
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

    if (threadDeleted) {
      void navigate({ to: "/", replace: true });
      return;
    }
    if (thread !== null || draftThreadExists) return;

    // Keep the request through effect cleanup so rerenders and StrictMode never reread the id.
    let request = readsByThreadId.current.get(threadId);
    if (request === undefined) {
      request = loadThread(threadId);
      readsByThreadId.current.set(threadId, request);
    }
    let cancelled = false;
    void request
      .then((loaded) => {
        if (cancelled) return;
        if (loaded === null || loaded.archivedAt !== null || loaded.deletedAt !== null)
          void navigate({ to: "/", replace: true });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        toastManager.add({
          type: "error",
          title: "Could not open the thread",
          description: error instanceof Error ? error.message : String(error),
        });
        void navigate({ to: "/", replace: true });
      });
    return () => {
      cancelled = true;
    };
  }, [
    navigate,
    draftThreadExists,
    threadId,
    thread,
    threadArchived,
    threadDeleted,
    startupHydrated,
  ]);

  useP29LayoutTrace({
    threadId,
    folderId: activeFolderId,
    expected:
      startupHydrated &&
      routeThreadExists &&
      !threadArchived &&
      !threadDeleted &&
      activeFolderId !== null,
  });

  if (threadArchived || threadDeleted) {
    return null;
  }

  if (!startupHydrated) {
    return null;
  }

  if (!routeThreadExists || activeFolderId === null) {
    return null;
  }

  return <SingleChatSurface threadId={threadId} folderId={activeFolderId} />;
}

export const Route = createFileRoute("/_chat/$threadId")({
  validateSearch: (search) => parseChatRouteSearch(search),
  component: ChatThreadRouteView,
});
