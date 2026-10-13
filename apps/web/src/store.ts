// FILE: store.ts
// Purpose: Public Zustand facade for normalized orchestration state and local UI actions.
// Exports: Stable store API plus pure transitions re-exported from focused modules.

import { ensureNativeApi } from "./nativeApi";

import { Fragment, type ReactNode, createElement, useEffect } from "react";
import { type OrchestrationThreadShell, type ThreadId } from "@penkra/contracts";
import { Debouncer } from "@tanstack/react-pacer";
import { create } from "zustand";

import {
  applySpaceOrder,
  applyThreadUpdate,
  removeDeletedProjectFromClientState,
  removeDeletedThreadFromClientState,
  syncServerThreadShell,
} from "./storeProjection";
import {
  persistState,
  readPersistedState,
  rememberProjectLocalNames,
  rememberProjectUiState,
} from "./storePersistence";
import { initialState, type AppState } from "./storeState";
import type { Project } from "./types";

export type { AppState } from "./storeState";
export { EMPTY_THREAD_IDS } from "./storeState";
export {
  applySpaceOrder,
  removeDeletedProjectFromClientState,
  removeDeletedThreadFromClientState,
  syncServerThreadShell,
} from "./storeProjection";

const debouncedPersistState = new Debouncer(persistState, { wait: 500 });

export function persistAppStateNow(state: AppState = useStore.getState()): void {
  persistState(state);
}

export async function markThreadVisited(threadId: ThreadId, visitedAt: string): Promise<void> {
  await ensureNativeApi().cleanCore.updateThread({
    update: { action: "visit", threadId, visitedAt, updatedAt: visitedAt },
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
    if (thread.error === error && thread.errorSource === undefined) return thread;
    return { ...thread, error, errorSource: undefined };
  });
}

// ── Zustand store ────────────────────────────────────────────────────

interface AppStore extends AppState {
  syncServerThreadShell: (threadId: ThreadId, thread: OrchestrationThreadShell | null) => void;
  removeDeletedProjectFromClientState: (folderId: Project["id"]) => void;
  removeDeletedThreadFromClientState: (threadId: ThreadId) => void;
  markThreadVisited: (threadId: ThreadId, visitedAt: string) => Promise<void>;
  toggleProject: (folderId: Project["id"]) => void;
  setProjectExpanded: (folderId: Project["id"], expanded: boolean) => void;
  setAllFoldersExpanded: (expanded: boolean) => void;
  collapseFoldersExcept: (activeFolderId: Project["id"] | null) => void;
  reorderFolders: (draggedFolderId: Project["id"], targetFolderId: Project["id"]) => void;
  renameProjectLocally: (folderId: Project["id"], name: string | null) => void;
  setError: (threadId: ThreadId, error: string | null) => void;
}

export const useStore = create<AppStore>((set) => ({
  ...readPersistedState(initialState),
  syncServerThreadShell: (threadId, thread) =>
    set((state) => syncServerThreadShell(state, threadId, thread)),
  removeDeletedProjectFromClientState: (folderId) =>
    set((state) => removeDeletedProjectFromClientState(state, folderId)),
  removeDeletedThreadFromClientState: (threadId) =>
    set((state) => removeDeletedThreadFromClientState(state, threadId)),
  markThreadVisited,
  toggleProject: (folderId) => set((state) => toggleProject(state, folderId)),
  setProjectExpanded: (folderId, expanded) =>
    set((state) => setProjectExpanded(state, folderId, expanded)),
  setAllFoldersExpanded: (expanded) => set((state) => setAllFoldersExpanded(state, expanded)),
  collapseFoldersExcept: (activeFolderId) =>
    set((state) => collapseFoldersExcept(state, activeFolderId)),
  reorderFolders: (draggedFolderId, targetFolderId) =>
    set((state) => reorderFolders(state, draggedFolderId, targetFolderId)),
  renameProjectLocally: (folderId, name) => {
    set((state) => renameProjectLocally(state, folderId, name));
    persistAppStateNow();
  },
  setError: (threadId, error) => set((state) => setError(state, threadId, error)),
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
