// FILE: rightDockStore.ts
// Purpose: Apply shared folder App-tab rows; retain runtime data and width per window.
// Layer: UI state store

import type {
  CleanCoreFolderAppTabsResult,
  CleanCoreUpdateFolderAppTabsInput,
  FolderId,
} from "@penkra/contracts";
import { create } from "zustand";

import { ensureNativeApi } from "./nativeApi";
import { toastManager } from "./components/ui/toast";
import {
  type OpenPaneInput,
  type RightDockPane,
  type RightDockFolderState,
  applyFolderAppTabsInState,
  createDefaultRightDockState,
  setDockWidthInState,
  updatePaneInState,
} from "./rightDockStore.logic";

type RuntimePane = Pick<
  RightDockPane,
  | "appDocumentUrl"
  | "appIconDataUrl"
  | "appPresentationTitle"
  | "appPresentationIconUrl"
  | "appRendererId"
  | "appState"
  | "appStatus"
>;

interface RightDockStore {
  dockStateByFolderId: Record<string, RightDockFolderState | undefined>;
  updatedAtByFolderId: Record<string, string | undefined>;
  runtimeByPaneId: Record<string, Partial<RuntimePane> | undefined>;
  openPane: (folderId: FolderId, input: OpenPaneInput) => void;
  receivePane: (folderId: FolderId, input: OpenPaneInput) => void;
  closePane: (folderId: FolderId, paneId: string) => void;
  setActivePane: (folderId: FolderId, paneId: string) => void;
  setDockOpen: (folderId: FolderId, open: boolean) => void;
  setDockWidth: (folderId: FolderId, width: number) => void;
  updatePane: (
    folderId: FolderId,
    paneId: string,
    patch: Partial<RuntimePane> & { appRoute?: string },
  ) => void;
  clearFolderDockState: (folderId: FolderId) => void;
}

const DEFAULT_RIGHT_DOCK_STATE = createDefaultRightDockState();
Object.freeze(DEFAULT_RIGHT_DOCK_STATE);
Object.freeze(DEFAULT_RIGHT_DOCK_STATE.panes);

function reportWriteFailure(error: unknown): void {
  toastManager.add({
    type: "error",
    title: "Could not update Apps",
    description: error instanceof Error ? error.message : "The App tabs could not be updated.",
  });
}

export function applyFolderAppTabs(result: CleanCoreFolderAppTabsResult): void {
  useRightDockStore.setState((store) => {
    const updatedAt = store.updatedAtByFolderId[result.folderId];
    if (updatedAt !== undefined && updatedAt > result.updatedAt) return {};
    return {
      updatedAtByFolderId: { ...store.updatedAtByFolderId, [result.folderId]: result.updatedAt },
      dockStateByFolderId: {
        ...store.dockStateByFolderId,
        [result.folderId]: applyFolderAppTabsInState(
          store.dockStateByFolderId[result.folderId] ?? DEFAULT_RIGHT_DOCK_STATE,
          result.tabs,
          store.runtimeByPaneId,
        ),
      },
    };
  });
}

export async function loadFolderAppTabs(folderId: FolderId): Promise<void> {
  const result = await ensureNativeApi().cleanCore.getFolderAppTabs({ folderId });
  if (result !== null) applyFolderAppTabs(result);
}

async function writeFolderAppTabs(
  folderId: FolderId,
  update: CleanCoreUpdateFolderAppTabsInput["update"],
): Promise<void> {
  const result = await ensureNativeApi().cleanCore.updateFolderAppTabs({
    folderId,
    update,
    updatedAt: new Date().toISOString(),
  });
  applyFolderAppTabs(result);
}

export const useRightDockStore = create<RightDockStore>()((set, get) => ({
  dockStateByFolderId: {},
  updatedAtByFolderId: {},
  runtimeByPaneId: {},
  receivePane: (folderId, input) => {
    get().updatePane(folderId, input.paneId, {
      ...(input.appDocumentUrl === undefined ? {} : { appDocumentUrl: input.appDocumentUrl }),
      ...(input.appIconDataUrl === undefined ? {} : { appIconDataUrl: input.appIconDataUrl }),
      ...(input.appPresentationTitle === undefined
        ? {}
        : { appPresentationTitle: input.appPresentationTitle }),
      ...(input.appPresentationIconUrl === undefined
        ? {}
        : { appPresentationIconUrl: input.appPresentationIconUrl }),
      ...(input.appRendererId === undefined ? {} : { appRendererId: input.appRendererId }),
      appState: input.appState,
      appStatus: input.appStatus,
    });
  },
  openPane: (folderId, input) => {
    get().receivePane(folderId, input);
    void writeFolderAppTabs(folderId, {
      action: "open",
      pane: {
        id: input.paneId,
        kind: input.kind,
        appId: input.appId,
        appSpaceId: input.appSpaceId,
        appSlug: input.appSlug,
        appName: input.appName,
        appRoute: input.appRoute,
      },
      preserveSelection: input.preserveSelection,
    }).catch(reportWriteFailure);
  },
  closePane: (folderId, paneId) => {
    void writeFolderAppTabs(folderId, { action: "close", paneId }).catch(reportWriteFailure);
  },
  setActivePane: (folderId, paneId) => {
    void writeFolderAppTabs(folderId, { action: "select", paneId }).catch(reportWriteFailure);
  },
  setDockOpen: (folderId, open) => {
    void writeFolderAppTabs(folderId, { action: "show", open }).catch(reportWriteFailure);
  },
  setDockWidth: (folderId, width) =>
    set((store) => ({
      dockStateByFolderId: {
        ...store.dockStateByFolderId,
        [folderId]: setDockWidthInState(
          store.dockStateByFolderId[folderId] ?? DEFAULT_RIGHT_DOCK_STATE,
          width,
        ),
      },
    })),
  updatePane: (folderId, paneId, patch) => {
    const { appRoute, ...runtime } = patch;
    set((store) => {
      const previous = store.dockStateByFolderId[folderId] ?? DEFAULT_RIGHT_DOCK_STATE;
      return {
        runtimeByPaneId: {
          ...store.runtimeByPaneId,
          [paneId]: { ...store.runtimeByPaneId[paneId], ...runtime },
        },
        dockStateByFolderId: {
          ...store.dockStateByFolderId,
          [folderId]: updatePaneInState(previous, paneId, runtime),
        },
      };
    });
    if (
      appRoute !== undefined &&
      get().dockStateByFolderId[folderId]?.panes.some(
        (pane) => pane.id === paneId && pane.appRoute !== appRoute,
      )
    ) {
      void writeFolderAppTabs(folderId, { action: "navigate", paneId, appRoute }).catch(
        reportWriteFailure,
      );
    }
  },
  clearFolderDockState: (folderId) =>
    set((store) => {
      const states = { ...store.dockStateByFolderId };
      const timestamps = { ...store.updatedAtByFolderId };
      const runtime = { ...store.runtimeByPaneId };
      for (const pane of states[folderId]?.panes ?? []) delete runtime[pane.id];
      delete states[folderId];
      delete timestamps[folderId];
      return {
        dockStateByFolderId: states,
        updatedAtByFolderId: timestamps,
        runtimeByPaneId: runtime,
      };
    }),
}));

export function selectRightDockState(folderId: FolderId) {
  return (store: RightDockStore) => store.dockStateByFolderId[folderId] ?? DEFAULT_RIGHT_DOCK_STATE;
}
