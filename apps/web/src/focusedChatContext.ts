// FILE: focusedChatContext.ts
// Purpose: Resolves the currently focused chat context across single and split chat surfaces.
// Layer: Route-aware UI helpers
// Exports: pure resolver and hook used by shortcut, discovery, and thread creation flows

import { ThreadId, type ThreadId as ThreadIdType } from "@penkra/contracts";
import { useMemo } from "react";
import { useParams } from "@tanstack/react-router";
import { type DraftThreadState, useComposerDraftStore } from "./composerDraftStore";
import { useChatRouteSearch } from "./hooks/useChatRouteSearch";
import {
  resolveSplitViewFocusedPaneThreadId,
  selectSplitView,
  type SplitView,
  useSplitViewStore,
} from "./splitViewStore";
import { useStore } from "./store";
import { createProjectSelector, createThreadSelector } from "./storeSelectors";
import type { Project, Thread } from "./types";

export interface FocusedChatContext {
  routeThreadId: ThreadIdType | null;
  splitView: SplitView | null;
  focusedThreadId: ThreadIdType | null;
  activeThread: Thread | null;
  activeDraftThread: DraftThreadState | null;
  activeProject: Project | null;
  activeFolderId: Project["id"] | null;
}

export function resolveFocusedChatContext(input: {
  routeThreadId: ThreadIdType | null;
  splitView: SplitView | null;
  threads: readonly Thread[];
  folders: readonly Project[];
  draftThreadsByThreadId: Record<string, DraftThreadState | undefined>;
}): FocusedChatContext {
  const focusedThreadId = input.splitView
    ? resolveSplitViewFocusedPaneThreadId(input.splitView)
    : input.routeThreadId;
  const activeThread =
    focusedThreadId !== null
      ? (input.threads.find((thread) => thread.id === focusedThreadId) ?? null)
      : null;
  const activeDraftThread =
    focusedThreadId !== null ? (input.draftThreadsByThreadId[focusedThreadId] ?? null) : null;
  const activeFolderId =
    activeDraftThread?.folderId ?? activeThread?.folderId ?? input.splitView?.ownerFolderId ?? null;
  const activeProject =
    activeFolderId !== null
      ? (input.folders.find((project) => project.id === activeFolderId) ?? null)
      : null;

  return {
    routeThreadId: input.routeThreadId,
    splitView: input.splitView,
    focusedThreadId,
    activeThread,
    activeDraftThread,
    activeProject,
    activeFolderId,
  };
}

export function useFocusedChatContext(): FocusedChatContext {
  const draftThreadsByThreadId = useComposerDraftStore((store) => store.draftThreadsByThreadId);
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const routeSearch = useChatRouteSearch();
  const activeSplitView = useSplitViewStore(
    useMemo(() => selectSplitView(routeSearch.splitViewId ?? null), [routeSearch.splitViewId]),
  );
  const focusedThreadId = activeSplitView
    ? resolveSplitViewFocusedPaneThreadId(activeSplitView)
    : routeThreadId;
  const activeThread = useStore(
    useMemo(() => createThreadSelector(focusedThreadId), [focusedThreadId]),
  );
  const activeDraftThread =
    focusedThreadId !== null ? (draftThreadsByThreadId[focusedThreadId] ?? null) : null;
  const activeFolderId =
    activeDraftThread?.folderId ?? activeThread?.folderId ?? activeSplitView?.ownerFolderId ?? null;
  const activeProject = useStore(
    useMemo(() => createProjectSelector(activeFolderId), [activeFolderId]),
  );

  return {
    routeThreadId,
    splitView: activeSplitView,
    focusedThreadId,
    activeThread: activeThread ?? null,
    activeDraftThread,
    activeProject: activeProject ?? null,
    activeFolderId,
  };
}
