// FILE: spacesUiStore.ts
// Purpose: Keeps per-window Space selection and last working-context restoration.

import type { FolderId, SpaceId, ThreadId } from "@penkra/contracts";
import { create } from "zustand";

import { readNativeApi } from "./nativeApi";

interface PersistedSpacesUiState {
  activeSpaceId: SpaceId | null;
  lastThreadIdBySpace: Record<string, ThreadId>;
  lastFolderIdBySpace: Record<string, FolderId>;
}

function recordsEqual<T extends string>(
  left: Record<string, T>,
  right: Record<string, T>,
): boolean {
  const leftEntries = Object.entries(left);
  return (
    leftEntries.length === Object.keys(right).length &&
    leftEntries.every(([key, value]) => right[key] === value)
  );
}

interface SpacesUiState extends PersistedSpacesUiState {
  serverHydrated: boolean;
  pendingActiveSpace: { spaceId: SpaceId; minSequence: number } | null;
  hydrateFromServer: () => Promise<void>;
  setActiveSpaceId: (spaceId: SpaceId) => void;
  setOptimisticActiveSpaceId: (spaceId: SpaceId, minSequence: number) => void;
  rememberThread: (spaceId: SpaceId, threadId: ThreadId) => void;
  rememberProject: (spaceId: SpaceId, folderId: FolderId) => void;
  getLastThreadId: (spaceId: SpaceId) => ThreadId | null;
  getLastFolderId: (spaceId: SpaceId) => FolderId | null;
  reconcile: (input: {
    activeSpaceIds: ReadonlySet<SpaceId>;
    snapshotSequence: number;
    projectSpaceById: ReadonlyMap<FolderId, SpaceId>;
    threadProjectById: ReadonlyMap<ThreadId, FolderId>;
    threadSpaceById: ReadonlyMap<ThreadId, SpaceId | null>;
  }) => void;
}

let durableWrite: Promise<unknown> = Promise.resolve();

function persistDurably(state: SpacesUiState): void {
  if (!state.serverHydrated) return;
  const api = readNativeApi();
  if (!api) return;
  const input = {
    activeSpaceId: state.activeSpaceId,
    lastThreadIdBySpace: state.lastThreadIdBySpace,
    lastFolderIdBySpace: state.lastFolderIdBySpace,
  };
  durableWrite = durableWrite
    .catch(() => undefined)
    .then(() => api.server.updateSpaceNavigationState(input));
}

export const useSpacesUiStore = create<SpacesUiState>((set, get) => ({
  activeSpaceId: null,
  lastThreadIdBySpace: {},
  lastFolderIdBySpace: {},
  serverHydrated: false,
  pendingActiveSpace: null,
  hydrateFromServer: async () => {
    if (get().serverHydrated) return;
    const api = readNativeApi();
    if (!api) return;
    const remote = await api.server.getSpaceNavigationState();
    set({
      activeSpaceId: remote.activeSpaceId,
      lastThreadIdBySpace: remote.lastThreadIdBySpace,
      lastFolderIdBySpace: remote.lastFolderIdBySpace,
      serverHydrated: true,
    });
  },
  setActiveSpaceId: (activeSpaceId) => {
    set({ activeSpaceId, pendingActiveSpace: null });
    persistDurably(get());
  },
  setOptimisticActiveSpaceId: (activeSpaceId, minSequence) => {
    set({ activeSpaceId, pendingActiveSpace: { spaceId: activeSpaceId, minSequence } });
    persistDurably(get());
  },
  rememberThread: (spaceId, threadId) => {
    const key = spaceId;
    if (get().lastThreadIdBySpace[key] === threadId && !(key in get().lastFolderIdBySpace)) return;
    set((state) => ({
      lastThreadIdBySpace: { ...state.lastThreadIdBySpace, [key]: threadId },
      lastFolderIdBySpace: Object.fromEntries(
        Object.entries(state.lastFolderIdBySpace).filter(([entryKey]) => entryKey !== key),
      ) as Record<string, FolderId>,
    }));
    persistDurably(get());
  },
  rememberProject: (spaceId, folderId) => {
    const key = spaceId;
    if (get().lastFolderIdBySpace[key] === folderId && !(key in get().lastThreadIdBySpace)) return;
    set((state) => ({
      lastFolderIdBySpace: { ...state.lastFolderIdBySpace, [key]: folderId },
      lastThreadIdBySpace: Object.fromEntries(
        Object.entries(state.lastThreadIdBySpace).filter(([entryKey]) => entryKey !== key),
      ) as Record<string, ThreadId>,
    }));
    persistDurably(get());
  },
  getLastThreadId: (spaceId) => get().lastThreadIdBySpace[spaceId] ?? null,
  getLastFolderId: (spaceId) => get().lastFolderIdBySpace[spaceId] ?? null,
  reconcile: ({
    activeSpaceIds,
    snapshotSequence,
    projectSpaceById,
    threadProjectById,
    threadSpaceById,
  }) => {
    const current = get();
    const pendingActiveSpace =
      current.pendingActiveSpace !== null &&
      (activeSpaceIds.has(current.pendingActiveSpace.spaceId) ||
        snapshotSequence >= current.pendingActiveSpace.minSequence)
        ? null
        : current.pendingActiveSpace;
    const reconciledActiveSpaceId =
      current.activeSpaceId !== null &&
      !activeSpaceIds.has(current.activeSpaceId) &&
      !(
        pendingActiveSpace?.spaceId === current.activeSpaceId &&
        snapshotSequence < pendingActiveSpace.minSequence
      )
        ? null
        : current.activeSpaceId;
    const activeSpaceId = reconciledActiveSpaceId;
    const lastThreadIdBySpace: Record<string, ThreadId> = {};
    for (const [key, threadId] of Object.entries(current.lastThreadIdBySpace)) {
      const folderId = threadProjectById.get(threadId);
      if (!folderId) continue;
      const assignedSpaceId = threadSpaceById.get(threadId) ?? projectSpaceById.get(folderId);
      if (assignedSpaceId === key) {
        lastThreadIdBySpace[key] = threadId;
      }
    }
    const lastFolderIdBySpace: Record<string, FolderId> = {};
    for (const [key, folderId] of Object.entries(current.lastFolderIdBySpace)) {
      const assignedSpaceId = projectSpaceById.get(folderId);
      if (assignedSpaceId === key) {
        lastFolderIdBySpace[key] = folderId;
      }
    }
    if (
      activeSpaceId === current.activeSpaceId &&
      pendingActiveSpace === current.pendingActiveSpace &&
      recordsEqual(lastThreadIdBySpace, current.lastThreadIdBySpace) &&
      recordsEqual(lastFolderIdBySpace, current.lastFolderIdBySpace)
    ) {
      return;
    }
    set({ activeSpaceId, pendingActiveSpace, lastThreadIdBySpace, lastFolderIdBySpace });
    persistDurably(get());
  },
}));

export function readActiveSpaceId(): SpaceId | null {
  return useSpacesUiStore.getState().activeSpaceId;
}
