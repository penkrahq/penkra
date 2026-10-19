// FILE: useRecentViewSwitcher.ts
// Purpose: Own the Ctrl+Tab recent-primary-view MRU wiring for the chat shell.
// Layer: UI hook
// Exports: useRecentViewSwitcher

import { useSidebarThreadRows } from "../sidebarThreadRows";
import { ThreadId } from "@penkra/contracts";
import { useLocation, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useMemo, useEffect, useRef, useState } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import {
  buildRecentViewDisplayEntries,
  deriveCurrentRecentView,
  pruneRecentViews,
  recentViewKey,
  resolveRecentViewNavigationIndex,
  type RecentView,
  type RecentViewAvailability,
  type RecentViewDisplayEntry,
  type RecentViewThreadDraftSummary,
} from "../recentViews.logic";
import { useRecentViewsStore } from "../recentViewsStore";
import { useStore } from "../store";
import type { useHandleNewThread } from "./useHandleNewThread";

type NewThreadContext = ReturnType<typeof useHandleNewThread>;

const EMPTY_RECENT_VIEW_ENTRIES: RecentViewDisplayEntry[] = [];

interface RecentViewSwitcherState {
  selectedIndex: number;
  selectedKey: string;
}

interface UseRecentViewSwitcherInput {
  activeContextThreadId: NewThreadContext["activeContextThreadId"];
  activeDraftThread: NewThreadContext["activeDraftThread"];
  folders: NewThreadContext["folders"];
}

// Encapsulates recent-view persistence, pruning and activation.
export function useRecentViewSwitcher(input: UseRecentViewSwitcherInput) {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const routeSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const [recentSwitcherState, setRecentSwitcherState] = useState<RecentViewSwitcherState | null>(
    null,
  );
  const recentViews = useRecentViewsStore((state) => state.recentViews);
  const recordRecentView = useRecentViewsStore((state) => state.recordRecentView);
  const pruneRecentViewsStore = useRecentViewsStore((state) => state.pruneRecentViews);
  const draftThreadsByThreadId = useComposerDraftStore((state) => state.draftThreadsByThreadId);
  const sidebarRows = useSidebarThreadRows();
  const sidebarThreadSummaryById = useMemo(
    () => Object.fromEntries(sidebarRows.map((row) => [row.id, row])),
    [sidebarRows],
  );
  const startupHydrated = useStore((state) => state.startupHydrated);
  const settingsSection = typeof routeSearch.section === "string" ? routeSearch.section : undefined;
  const currentRecentView = deriveCurrentRecentView({
    pathname,
    routeThreadId,
    activeThreadId: routeThreadId ? (input.activeContextThreadId ?? routeThreadId) : null,
    settingsSection,
  });
  const currentRecentViewKey = currentRecentView ? recentViewKey(currentRecentView) : null;
  const switcherOpen = recentSwitcherState !== null;
  let recentViewEntries: RecentViewDisplayEntry[] = EMPTY_RECENT_VIEW_ENTRIES;
  if (switcherOpen) {
    const draftThreadsById: Record<string, RecentViewThreadDraftSummary> = {};
    for (const [threadId, draftThread] of Object.entries(draftThreadsByThreadId)) {
      draftThreadsById[threadId] = {
        id: ThreadId.makeUnsafe(threadId),
        folderId: draftThread.folderId,
      };
    }
    if (input.activeDraftThread && input.activeContextThreadId) {
      draftThreadsById[input.activeContextThreadId] = {
        id: input.activeContextThreadId,
        folderId: input.activeDraftThread.folderId,
      };
    }
    recentViewEntries = buildRecentViewDisplayEntries({
      recentViews,
      currentView: currentRecentView,
      threadsById: sidebarThreadSummaryById,
      draftThreadsById,
      folders: input.folders,
    });
  }
  const currentRecentViewRef = useRef<RecentView | null>(currentRecentView);
  const recentSwitcherStateRef = useRef<RecentViewSwitcherState | null>(recentSwitcherState);
  const recentViewsRef = useRef(recentViews);
  const activeContextThreadIdRef = useRef(input.activeContextThreadId);
  const activeDraftThreadRef = useRef(input.activeDraftThread);
  const didHydrationPruneRef = useRef(false);

  useEffect(() => {
    currentRecentViewRef.current = currentRecentView;
  }, [currentRecentView]);

  useEffect(() => {
    recentSwitcherStateRef.current = recentSwitcherState;
  }, [recentSwitcherState]);

  useEffect(() => {
    recentViewsRef.current = recentViews;
  }, [recentViews]);

  useEffect(() => {
    activeContextThreadIdRef.current = input.activeContextThreadId;
  }, [input.activeContextThreadId]);

  useEffect(() => {
    activeDraftThreadRef.current = input.activeDraftThread;
  }, [input.activeDraftThread]);

  const buildRecentViewAvailability = (): RecentViewAvailability => {
    const sidebarThreadSummaryById = useStore.getState().sidebarThreadSummaryById;
    const draftThreadsByThreadId = useComposerDraftStore.getState().draftThreadsByThreadId;
    const activeContextThreadId = activeContextThreadIdRef.current;
    const activeDraftThread = activeDraftThreadRef.current;

    const availableThreadIds = new Set<ThreadId>();
    for (const threadId of Object.keys(sidebarThreadSummaryById)) {
      if (sidebarThreadSummaryById[threadId]?.archivedAt == null) {
        availableThreadIds.add(ThreadId.makeUnsafe(threadId));
      }
    }
    for (const threadId of Object.keys(draftThreadsByThreadId)) {
      if (sidebarThreadSummaryById[threadId]?.archivedAt == null) {
        availableThreadIds.add(ThreadId.makeUnsafe(threadId));
      }
    }
    if (
      activeDraftThread &&
      activeContextThreadId &&
      sidebarThreadSummaryById[activeContextThreadId]?.archivedAt == null
    ) {
      availableThreadIds.add(activeContextThreadId);
    }

    return {
      availableThreadIds,
    };
  };

  useEffect(() => {
    if (!currentRecentView) return;
    recordRecentView(currentRecentView);
  }, [currentRecentView, currentRecentViewKey, recordRecentView]);

  useEffect(() => {
    if (!startupHydrated || didHydrationPruneRef.current) return;
    didHydrationPruneRef.current = true;
    pruneRecentViewsStore(buildRecentViewAvailability());
  }, [buildRecentViewAvailability, pruneRecentViewsStore, startupHydrated]);

  const activateRecentView = (view: RecentView) => {
    switch (view.kind) {
      case "thread": {
        if (!buildRecentViewAvailability().availableThreadIds.has(view.threadId)) {
          return;
        }
        void navigate({
          to: "/$threadId",
          params: { threadId: view.threadId },
          search: () => ({}),
        });
        return;
      }
      case "settings":
        void navigate({
          to: "/settings",
          search: () => (view.section ? { section: view.section } : {}),
        });
        return;
    }
  };

  const commitRecentSwitcherSelection = () => {
    const state = recentSwitcherStateRef.current;
    if (!state) return;
    const views = recentViewsRef.current;
    const view =
      views.find((candidate) => recentViewKey(candidate) === state.selectedKey) ??
      views[state.selectedIndex];
    setRecentSwitcherState(null);
    if (!view) return;
    activateRecentView(view);
  };

  const cancelRecentSwitcher = () => {
    setRecentSwitcherState(null);
  };

  const openOrAdvanceRecentSwitcher = (direction: "next" | "previous") => {
    const currentState = recentSwitcherStateRef.current;
    let views = recentViewsRef.current;
    if (currentState === null) {
      const availability = buildRecentViewAvailability();
      pruneRecentViewsStore(availability);
      views = pruneRecentViews(views, availability);
    }
    const selectedIndex = resolveRecentViewNavigationIndex({
      recentViews: views,
      currentView: currentRecentViewRef.current,
      selectedKey: currentState?.selectedKey,
      direction,
    });

    if (selectedIndex === null) {
      return false;
    }

    const selectedView = views[selectedIndex];
    if (!selectedView) {
      return false;
    }

    setRecentSwitcherState({
      selectedIndex,
      selectedKey: recentViewKey(selectedView),
    });
    return true;
  };

  useEffect(() => {
    const onWindowKeyUp = (event: KeyboardEvent) => {
      if (!recentSwitcherStateRef.current || event.ctrlKey) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      commitRecentSwitcherSelection();
    };
    const onWindowBlur = () => {
      commitRecentSwitcherSelection();
    };

    window.addEventListener("keyup", onWindowKeyUp, { capture: true });
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("keyup", onWindowKeyUp, { capture: true });
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [commitRecentSwitcherSelection]);

  return {
    recentSwitcherState,
    recentViewEntries,
    openOrAdvanceRecentSwitcher,
    commitRecentSwitcherSelection,
    cancelRecentSwitcher,
  };
}
