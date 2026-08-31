// FILE: store.ts
// Purpose: Public Zustand facade for normalized orchestration state and local UI actions.
// Exports: Stable store API plus pure transitions re-exported from focused modules.

import { Fragment, type ReactNode, createElement, useEffect } from "react";
import {
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamEvent,
  type OrchestrationGetThreadTurnsPageResult,
  type SpaceId,
  type ThreadId,
} from "@penkra/contracts";
import { Debouncer } from "@tanstack/react-pacer";
import { create } from "zustand";

import {
  applySpaceOrder,
  applyShellEvent,
  applyThreadUpdate,
  clearThreadDetailSyncFailureInClientState,
  evictThreadDetailFromClientState,
  markThreadDetailKnownEmptyInClientState,
  markThreadDetailSyncFailedInClientState,
  removeDeletedProjectFromClientState,
  removeDeletedThreadFromClientState,
  syncServerReadModel,
  syncServerShellSnapshot,
  syncServerThreadDetail,
  syncServerThreadDetailHotPath,
  syncServerThreadTurnsPage,
} from "./storeProjection";
import { applyOrchestrationEvents, applyOrchestrationEventsHotPath } from "./storeEventReducer";
import {
  persistState,
  readPersistedState,
  rememberProjectLocalNames,
  rememberProjectUiState,
} from "./storePersistence";
import { initialState, type AppState } from "./storeState";
import type { Project, ThreadWorkspacePatch } from "./types";

type ReadModelThread = OrchestrationReadModel["threads"][number];

export type { AppState } from "./storeState";
export { EMPTY_THREAD_IDS } from "./storeState";
export {
  applySpaceOrder,
  applyShellEvent,
  clearThreadDetailSyncFailureInClientState,
  evictThreadDetailFromClientState,
  markThreadDetailKnownEmptyInClientState,
  markThreadDetailSyncFailedInClientState,
  removeDeletedProjectFromClientState,
  removeDeletedThreadFromClientState,
  syncServerReadModel,
  syncServerShellSnapshot,
  syncServerThreadDetail,
  syncServerThreadDetailHotPath,
  syncServerThreadTurnsPage,
} from "./storeProjection";
export { applyOrchestrationEvents, applyOrchestrationEventsHotPath } from "./storeEventReducer";

const debouncedPersistState = new Debouncer(persistState, { wait: 500 });

export function persistAppStateNow(state: AppState = useStore.getState()): void {
  persistState(state);
}

export function markThreadVisited(
  state: AppState,
  threadId: ThreadId,
  visitedAt?: string,
): AppState {
  const at = visitedAt ?? new Date().toISOString();
  const visitedAtMs = Date.parse(at);
  return applyThreadUpdate(state, threadId, (thread) => {
    const previousVisitedAtMs = thread.lastVisitedAt ? Date.parse(thread.lastVisitedAt) : NaN;
    if (
      Number.isFinite(previousVisitedAtMs) &&
      Number.isFinite(visitedAtMs) &&
      previousVisitedAtMs >= visitedAtMs
    ) {
      return thread;
    }
    return { ...thread, lastVisitedAt: at };
  });
}

export function markThreadUnread(state: AppState, threadId: ThreadId): AppState {
  return applyThreadUpdate(state, threadId, (thread) => {
    if (!thread.latestTurn?.completedAt) return thread;
    const latestTurnCompletedAtMs = Date.parse(thread.latestTurn.completedAt);
    if (Number.isNaN(latestTurnCompletedAtMs)) return thread;
    const unreadVisitedAt = new Date(latestTurnCompletedAtMs - 1).toISOString();
    if (thread.lastVisitedAt === unreadVisitedAt) return thread;
    return { ...thread, lastVisitedAt: unreadVisitedAt };
  });
}

export function toggleProject(state: AppState, folderId: Project["id"]): AppState {
  return {
    ...state,
    folders: state.folders.map((p) => (p.id === folderId ? { ...p, expanded: !p.expanded } : p)),
  };
}

export function setProjectExpanded(
  state: AppState,
  folderId: Project["id"],
  expanded: boolean,
): AppState {
  let changed = false;
  const folders = state.folders.map((p) => {
    if (p.id !== folderId || p.expanded === expanded) return p;
    changed = true;
    return { ...p, expanded };
  });
  return changed ? { ...state, folders } : state;
}

export function setAllFoldersExpanded(state: AppState, expanded: boolean): AppState {
  let changed = false;
  const folders = state.folders.map((project) => {
    if (project.expanded === expanded) return project;
    changed = true;
    return { ...project, expanded };
  });
  return changed ? { ...state, folders } : state;
}

export function collapseFoldersExcept(
  state: AppState,
  activeFolderId: Project["id"] | null,
): AppState {
  let changed = false;
  const folders = state.folders.map((project) => {
    const nextExpanded = activeFolderId !== null && project.id === activeFolderId;
    if (project.expanded === nextExpanded) return project;
    changed = true;
    return { ...project, expanded: nextExpanded };
  });
  return changed ? { ...state, folders } : state;
}

export function reorderFolders(
  state: AppState,
  draggedFolderId: Project["id"],
  targetFolderId: Project["id"],
): AppState {
  if (draggedFolderId === targetFolderId) return state;
  const draggedIndex = state.folders.findIndex((project) => project.id === draggedFolderId);
  const targetIndex = state.folders.findIndex((project) => project.id === targetFolderId);
  if (draggedIndex < 0 || targetIndex < 0) return state;
  const folders = [...state.folders];
  const [draggedProject] = folders.splice(draggedIndex, 1);
  if (!draggedProject) return state;
  folders.splice(targetIndex, 0, draggedProject);
  return { ...state, folders };
}

export function renameProjectLocally(
  state: AppState,
  folderId: Project["id"],
  name: string | null,
): AppState {
  const normalizedName = name?.trim() ?? null;
  let changed = false;
  const folders = state.folders.map((project) => {
    if (project.id !== folderId) {
      return project;
    }
    const nextLocalName = normalizedName && normalizedName.length > 0 ? normalizedName : null;
    const nextName = nextLocalName ?? project.remoteName;
    if (project.localName === nextLocalName && project.name === nextName) {
      return project;
    }
    changed = true;
    return {
      ...project,
      name: nextName,
      localName: nextLocalName,
    };
  });
  return changed ? { ...state, folders } : state;
}

export function setError(state: AppState, threadId: ThreadId, error: string | null): AppState {
  return applyThreadUpdate(state, threadId, (thread) => {
    if (thread.error === error) return thread;
    return { ...thread, error };
  });
}

export function setThreadWorkspace(
  state: AppState,
  threadId: ThreadId,
  patch: ThreadWorkspacePatch,
): AppState {
  return applyThreadUpdate(state, threadId, (t) => {
    const nextWorkingDirectory =
      patch.workingDirectory !== undefined ? patch.workingDirectory : (t.workingDirectory ?? null);
    if ((t.workingDirectory ?? null) === nextWorkingDirectory) {
      return t;
    }
    return {
      ...t,
      workingDirectory: nextWorkingDirectory,
      session: null,
    };
  });
}

// ── Zustand store ────────────────────────────────────────────────────

interface AppStore extends AppState {
  syncServerShellSnapshot: (snapshot: OrchestrationShellSnapshot) => void;
  syncServerThreadDetail: (thread: ReadModelThread) => void;
  syncServerThreadDetailHotPath: (thread: ReadModelThread) => void;
  syncServerThreadTurnsPage: (page: OrchestrationGetThreadTurnsPageResult) => void;
  syncServerReadModel: (readModel: OrchestrationReadModel) => void;
  applyShellEvent: (event: OrchestrationShellStreamEvent) => void;
  applyOrchestrationEvents: (events: ReadonlyArray<OrchestrationEvent>) => void;
  applyOrchestrationEventsHotPath: (events: ReadonlyArray<OrchestrationEvent>) => void;
  evictThreadDetail: (threadId: ThreadId) => void;
  evictThreadDetails: (threadIds: readonly ThreadId[]) => void;
  markThreadDetailSyncFailed: (threadId: ThreadId) => void;
  markThreadDetailKnownEmpty: (threadId: ThreadId) => void;
  clearThreadDetailSyncFailure: (threadId: ThreadId) => void;
  removeDeletedProjectFromClientState: (folderId: Project["id"]) => void;
  removeDeletedThreadFromClientState: (threadId: ThreadId) => void;
  markThreadVisited: (threadId: ThreadId, visitedAt?: string) => void;
  markThreadUnread: (threadId: ThreadId) => void;
  toggleProject: (folderId: Project["id"]) => void;
  setProjectExpanded: (folderId: Project["id"], expanded: boolean) => void;
  setAllFoldersExpanded: (expanded: boolean) => void;
  collapseFoldersExcept: (activeFolderId: Project["id"] | null) => void;
  reorderFolders: (draggedFolderId: Project["id"], targetFolderId: Project["id"]) => void;
  reorderSpacesLocally: (orderedSpaceIds: ReadonlyArray<SpaceId>) => void;
  renameProjectLocally: (folderId: Project["id"], name: string | null) => void;
  setError: (threadId: ThreadId, error: string | null) => void;
  setThreadWorkspace: (threadId: ThreadId, patch: ThreadWorkspacePatch) => void;
}

export const useStore = create<AppStore>((set) => ({
  ...readPersistedState(initialState),
  syncServerShellSnapshot: (snapshot) => set((state) => syncServerShellSnapshot(state, snapshot)),
  syncServerThreadDetail: (thread) => set((state) => syncServerThreadDetail(state, thread)),
  syncServerThreadDetailHotPath: (thread) =>
    set((state) => syncServerThreadDetailHotPath(state, thread)),
  syncServerThreadTurnsPage: (page) => set((state) => syncServerThreadTurnsPage(state, page)),
  syncServerReadModel: (readModel) => set((state) => syncServerReadModel(state, readModel)),
  applyShellEvent: (event) => set((state) => applyShellEvent(state, event)),
  applyOrchestrationEvents: (events) => set((state) => applyOrchestrationEvents(state, events)),
  applyOrchestrationEventsHotPath: (events) =>
    set((state) =>
      applyOrchestrationEventsHotPath(state, events, {
        updateSidebarSummary: false,
      }),
    ),
  evictThreadDetail: (threadId) =>
    set((state) => evictThreadDetailFromClientState(state, threadId)),
  // Dropping a batch of leases evicts several threads at once. Every store update
  // re-runs the retention reconcile, so folding them into one write keeps that at
  // a single pass instead of one per thread.
  evictThreadDetails: (threadIds) =>
    set((state) => {
      let nextState: AppState = state;
      for (const threadId of threadIds) {
        nextState = evictThreadDetailFromClientState(nextState, threadId);
      }
      return nextState;
    }),
  markThreadDetailSyncFailed: (threadId) =>
    set((state) => markThreadDetailSyncFailedInClientState(state, threadId)),
  markThreadDetailKnownEmpty: (threadId) =>
    set((state) => markThreadDetailKnownEmptyInClientState(state, threadId)),
  clearThreadDetailSyncFailure: (threadId) =>
    set((state) => clearThreadDetailSyncFailureInClientState(state, threadId)),
  removeDeletedProjectFromClientState: (folderId) =>
    set((state) => removeDeletedProjectFromClientState(state, folderId)),
  removeDeletedThreadFromClientState: (threadId) =>
    set((state) => removeDeletedThreadFromClientState(state, threadId)),
  markThreadVisited: (threadId, visitedAt) =>
    set((state) => markThreadVisited(state, threadId, visitedAt)),
  markThreadUnread: (threadId) => set((state) => markThreadUnread(state, threadId)),
  toggleProject: (folderId) => set((state) => toggleProject(state, folderId)),
  setProjectExpanded: (folderId, expanded) =>
    set((state) => setProjectExpanded(state, folderId, expanded)),
  setAllFoldersExpanded: (expanded) => set((state) => setAllFoldersExpanded(state, expanded)),
  collapseFoldersExcept: (activeFolderId) =>
    set((state) => collapseFoldersExcept(state, activeFolderId)),
  reorderFolders: (draggedFolderId, targetFolderId) =>
    set((state) => reorderFolders(state, draggedFolderId, targetFolderId)),
  reorderSpacesLocally: (orderedSpaceIds) =>
    set((state) => applySpaceOrder(state, orderedSpaceIds)),
  renameProjectLocally: (folderId, name) => {
    set((state) => renameProjectLocally(state, folderId, name));
    persistAppStateNow();
  },
  setError: (threadId, error) => set((state) => setError(state, threadId, error)),
  setThreadWorkspace: (threadId, patch) =>
    set((state) => setThreadWorkspace(state, threadId, patch)),
}));

// Persist state changes with debouncing to avoid localStorage thrashing
useStore.subscribe((state) => {
  rememberProjectUiState(state.folders);
  rememberProjectLocalNames(state.folders);
  debouncedPersistState.maybeExecute(state);
});

// Flush pending writes synchronously before page unload to prevent data loss.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    persistAppStateNow();
  });
}

export function StoreProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    persistAppStateNow();
  }, []);
  return createElement(Fragment, null, children);
}
