// FILE: pinnedFoldersStore.ts
// Purpose: Persists sidebar project pin ids with the shared pin ordering cap.
// Layer: UI state store
// Exports: usePinnedFoldersStore

import { MAX_PINNED_PROJECTS, type FolderId } from "@penkra/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { normalizePinnedIds, pinId, prunePinnedIds, unpinId } from "./pinning.logic";

interface PinnedFoldersStoreState {
  pinnedFolderIds: FolderId[];
  pinProject: (folderId: FolderId) => boolean;
  unpinProject: (folderId: FolderId) => void;
  prunePinnedFolders: (folderIds: readonly FolderId[]) => void;
}

const PINNED_PROJECTS_STORAGE_KEY = "penkra:pinned-folders:v1";
const PINNED_PROJECTS_OPTIONS = { maxCount: MAX_PINNED_PROJECTS } as const;

export const usePinnedFoldersStore = create<PinnedFoldersStoreState>()(
  persist(
    (set, get) => ({
      pinnedFolderIds: [],
      pinProject: (folderId) => {
        if (folderId.length === 0) return false;
        const result = pinId(get().pinnedFolderIds, folderId, PINNED_PROJECTS_OPTIONS);
        if (result.rejected) {
          return false;
        }
        if (result.changed) {
          set({ pinnedFolderIds: result.pinnedIds });
        }
        return true;
      },
      unpinProject: (folderId) => {
        if (folderId.length === 0) return;
        set((state) => {
          const result = unpinId(state.pinnedFolderIds, folderId);
          if (!result.changed) {
            return state;
          }
          return {
            pinnedFolderIds: result.pinnedIds,
          };
        });
      },
      prunePinnedFolders: (folderIds) => {
        set((state) => {
          const nextPinnedFolderIds = prunePinnedIds(state.pinnedFolderIds, folderIds).slice(
            0,
            MAX_PINNED_PROJECTS,
          );
          return nextPinnedFolderIds.length === state.pinnedFolderIds.length &&
            nextPinnedFolderIds.every((id, index) => id === state.pinnedFolderIds[index])
            ? state
            : { pinnedFolderIds: nextPinnedFolderIds };
        });
      },
    }),
    {
      name: PINNED_PROJECTS_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        pinnedFolderIds: normalizePinnedIds(state.pinnedFolderIds, PINNED_PROJECTS_OPTIONS),
      }),
      merge: (persistedState, currentState) => {
        const candidate =
          (persistedState as Partial<Pick<PinnedFoldersStoreState, "pinnedFolderIds">> | undefined)
            ?.pinnedFolderIds ?? [];
        return {
          ...currentState,
          pinnedFolderIds: normalizePinnedIds(candidate, PINNED_PROJECTS_OPTIONS),
        };
      },
    },
  ),
);
