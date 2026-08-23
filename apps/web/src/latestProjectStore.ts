import type { FolderId } from "@penkra/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

const LATEST_PROJECT_STORAGE_KEY = "penkra:latest-project:v1";

interface LatestProjectStore {
  latestFolderId: FolderId | null;
  setLatestFolderId: (folderId: FolderId) => void;
  clearLatestFolderId: (folderId?: FolderId) => void;
}

export const useLatestProjectStore = create<LatestProjectStore>()(
  persist(
    (set) => ({
      latestFolderId: null,
      setLatestFolderId: (folderId) => set({ latestFolderId: folderId }),
      clearLatestFolderId: (folderId) =>
        set((state) => {
          if (folderId && state.latestFolderId !== folderId) {
            return state;
          }
          if (state.latestFolderId === null) {
            return state;
          }
          return { latestFolderId: null };
        }),
    }),
    {
      name: LATEST_PROJECT_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      // Guard against a corrupt persisted value (non-string) reaching consumers
      // that treat it as a project id.
      merge: (persisted, current) => {
        const persistedId = (persisted as { latestFolderId?: unknown } | undefined)?.latestFolderId;
        return {
          ...current,
          latestFolderId: typeof persistedId === "string" ? (persistedId as FolderId) : null,
        };
      },
    },
  ),
);
