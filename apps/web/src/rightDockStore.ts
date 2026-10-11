// FILE: rightDockStore.ts
// Purpose: Keep App-tab state in memory per folder.
// Layer: UI state store
// Exports: dock store hook, per-folder selector, stable default snapshot.

import type { FolderId } from "@penkra/contracts";
import { create } from "zustand";

import {
  type OpenPaneInput,
  type RightDockPane,
  type RightDockFolderState,
  closePaneInState,
  createDefaultRightDockState,
  openPaneInState,
  setActivePaneInState,
  setDockOpenInState,
  setDockWidthInState,
  updatePaneInState,
} from "./rightDockStore.logic";

interface RightDockStore {
  dockStateByFolderId: Record<string, RightDockFolderState | undefined>;
  openPane: (folderId: FolderId, input: OpenPaneInput) => void;
  closePane: (folderId: FolderId, paneId: string) => void;
  setActivePane: (folderId: FolderId, paneId: string) => void;
  setDockOpen: (folderId: FolderId, open: boolean) => void;
  setDockWidth: (folderId: FolderId, width: number) => void;
  updatePane: (
    folderId: FolderId,
    paneId: string,
    patch: Partial<
      Pick<
        RightDockPane,
        | "appDocumentUrl"
        | "appIconDataUrl"
        | "appPresentationTitle"
        | "appPresentationIconUrl"
        | "appRendererId"
        | "appRoute"
        | "appState"
        | "appStatus"
      >
    >,
  ) => void;
  clearFolderDockState: (folderId: FolderId) => void;
}

// Frozen shared snapshot: it is handed back from `selectRightDockState` for any
// thread without persisted dock state, so it must stay a stable, immutable
// reference (transitions always build new objects rather than mutating it).
const DEFAULT_RIGHT_DOCK_STATE = createDefaultRightDockState();
Object.freeze(DEFAULT_RIGHT_DOCK_STATE);
Object.freeze(DEFAULT_RIGHT_DOCK_STATE.panes);

function commit(
  set: (fn: (store: RightDockStore) => Partial<RightDockStore>) => void,
  folderId: FolderId,
  transform: (state: RightDockFolderState) => RightDockFolderState,
): void {
  set((store) => {
    const previous = store.dockStateByFolderId[folderId] ?? DEFAULT_RIGHT_DOCK_STATE;
    const next = transform(previous);
    if (next === previous) {
      return {};
    }
    return {
      dockStateByFolderId: {
        ...store.dockStateByFolderId,
        [folderId]: next,
      },
    };
  });
}

export const useRightDockStore = create<RightDockStore>()((set) => ({
  dockStateByFolderId: {},
  openPane: (folderId, input) => commit(set, folderId, (state) => openPaneInState(state, input)),
  closePane: (folderId, paneId) =>
    commit(set, folderId, (state) => closePaneInState(state, paneId)),
  setActivePane: (folderId, paneId) =>
    commit(set, folderId, (state) => setActivePaneInState(state, paneId)),
  setDockOpen: (folderId, open) =>
    commit(set, folderId, (state) => setDockOpenInState(state, open)),
  setDockWidth: (folderId, width) =>
    commit(set, folderId, (state) => setDockWidthInState(state, width)),
  updatePane: (folderId, paneId, patch) =>
    commit(set, folderId, (state) => updatePaneInState(state, paneId, patch)),
  clearFolderDockState: (folderId) =>
    set((store) => {
      if (!Object.hasOwn(store.dockStateByFolderId, folderId)) {
        return {};
      }
      const next = { ...store.dockStateByFolderId };
      delete next[folderId];
      return { dockStateByFolderId: next };
    }),
}));

export function selectRightDockState(folderId: FolderId) {
  // Keep the fallback snapshot stable so React does not observe phantom store
  // changes while mounting a thread that has no dock state yet.
  return (store: RightDockStore) => store.dockStateByFolderId[folderId] ?? DEFAULT_RIGHT_DOCK_STATE;
}
