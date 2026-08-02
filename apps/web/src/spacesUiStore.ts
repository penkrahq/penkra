// FILE: spacesUiStore.ts
// Purpose: Keeps per-window Space selection and last working-context restoration.

import type { ContainerId, SpaceId, ThreadId } from "@penkra/contracts";
import { create } from "zustand";

import { readNativeApi } from "./nativeApi";

interface PersistedSpacesUiState {
  activeSpaceId: SpaceId | null;
  lastThreadIdBySpace: Record<string, ThreadId>;
  lastProjectIdBySpace: Record<string, ContainerId>;
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
  rememberProject: (spaceId: SpaceId, projectId: ContainerId) => void;
  getLastThreadId: (spaceId: SpaceId) => ThreadId | null;
  getLastProjectId: (spaceId: SpaceId) => ContainerId | null;
  reconcile: (input: {
    activeSpaceIds: ReadonlySet<SpaceId>;
    snapshotSequence: number;
    projectSpaceById: ReadonlyMap<ContainerId, SpaceId>;
    threadProjectById: ReadonlyMap<ThreadId, ContainerId>;
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
    lastProjectIdBySpace: state.lastProjectIdBySpace,
  };
  durableWrite = durableWrite
    .catch(() => undefined)
    .then(() => api.server.updateSpaceNavigationState(input));
}

export const useSpacesUiStore = create<SpacesUiState>((set, get) => ({
  activeSpaceId: null,
  lastThreadIdBySpace: {},
  lastProjectIdBySpace: {},
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
      lastProjectIdBySpace: remote.lastProjectIdBySpace,
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
    if (get().lastThreadIdBySpace[key] === threadId && !(key in get().lastProjectIdBySpace)) return;
    set((state) => ({
      lastThreadIdBySpace: { ...state.lastThreadIdBySpace, [key]: threadId },
      lastProjectIdBySpace: Object.fromEntries(
        Object.entries(state.lastProjectIdBySpace).filter(([entryKey]) => entryKey !== key),
      ) as Record<string, ContainerId>,
    }));
    persistDurably(get());
  },
  rememberProject: (spaceId, projectId) => {
    const key = spaceId;
    if (get().lastProjectIdBySpace[key] === projectId && !(key in get().lastThreadIdBySpace))
      return;
    set((state) => ({
      lastProjectIdBySpace: { ...state.lastProjectIdBySpace, [key]: projectId },
      lastThreadIdBySpace: Object.fromEntries(
        Object.entries(state.lastThreadIdBySpace).filter(([entryKey]) => entryKey !== key),
      ) as Record<string, ThreadId>,
    }));
    persistDurably(get());
  },
  getLastThreadId: (spaceId) => get().lastThreadIdBySpace[spaceId] ?? null,
  getLastProjectId: (spaceId) => get().lastProjectIdBySpace[spaceId] ?? null,
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
      const projectId = threadProjectById.get(threadId);
      if (!projectId) continue;
      const assignedSpaceId = threadSpaceById.get(threadId) ?? projectSpaceById.get(projectId);
      if (assignedSpaceId === key) {
        lastThreadIdBySpace[key] = threadId;
      }
    }
    const lastProjectIdBySpace: Record<string, ContainerId> = {};
    for (const [key, projectId] of Object.entries(current.lastProjectIdBySpace)) {
      const assignedSpaceId = projectSpaceById.get(projectId);
      if (assignedSpaceId === key) {
        lastProjectIdBySpace[key] = projectId;
      }
    }
    if (
      activeSpaceId === current.activeSpaceId &&
      pendingActiveSpace === current.pendingActiveSpace &&
      recordsEqual(lastThreadIdBySpace, current.lastThreadIdBySpace) &&
      recordsEqual(lastProjectIdBySpace, current.lastProjectIdBySpace)
    ) {
      return;
    }
    set({ activeSpaceId, pendingActiveSpace, lastThreadIdBySpace, lastProjectIdBySpace });
    persistDurably(get());
  },
}));

export function readActiveSpaceId(): SpaceId | null {
  return useSpacesUiStore.getState().activeSpaceId;
}
