// FILE: rightDockStore.ts
// Purpose: Persist App-tab state per host Thread.
// Layer: UI state store
// Exports: dock store hook, per-thread selector, and stable default snapshot.

import type { ThreadId } from "@penkra/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import {
  type OpenPaneInput,
  type RightDockPane,
  type RightDockThreadState,
  closePaneInState,
  createDefaultRightDockState,
  openPaneInState,
  sanitizeRightDockStateByThreadId,
  setActivePaneInState,
  setDockOpenInState,
  setDockWidthInState,
  updatePaneInState,
} from "./rightDockStore.logic";

const RIGHT_DOCK_STORAGE_KEY = "penkra:app-tabs-by-thread:v1";

interface RightDockStore {
  dockStateByThreadId: Record<string, RightDockThreadState | undefined>;
  openPane: (threadId: ThreadId, input: OpenPaneInput) => void;
  closePane: (threadId: ThreadId, paneId: string) => void;
  setActivePane: (threadId: ThreadId, paneId: string) => void;
  setDockOpen: (threadId: ThreadId, open: boolean) => void;
  setDockWidth: (threadId: ThreadId, width: number) => void;
  updatePane: (
    threadId: ThreadId,
    paneId: string,
    patch: Partial<
      Pick<
        RightDockPane,
        | "appDocumentUrl"
        | "appIconDataUrl"
        | "appRendererId"
        | "appRoute"
        | "appState"
        | "appStatus"
      >
    >,
  ) => void;
  clearThreadDockState: (threadId: ThreadId) => void;
}

// Frozen shared snapshot: it is handed back from `selectRightDockState` for any
// thread without persisted dock state, so it must stay a stable, immutable
// reference (transitions always build new objects rather than mutating it).
const DEFAULT_RIGHT_DOCK_STATE = createDefaultRightDockState();
Object.freeze(DEFAULT_RIGHT_DOCK_STATE);
Object.freeze(DEFAULT_RIGHT_DOCK_STATE.panes);

function commit(
  set: (fn: (store: RightDockStore) => Partial<RightDockStore>) => void,
  threadId: ThreadId,
  transform: (state: RightDockThreadState) => RightDockThreadState,
): void {
  set((store) => {
    const previous = store.dockStateByThreadId[threadId] ?? DEFAULT_RIGHT_DOCK_STATE;
    const next = transform(previous);
    if (next === previous) {
      return {};
    }
    return {
      dockStateByThreadId: {
        ...store.dockStateByThreadId,
        [threadId]: next,
      },
    };
  });
}

export const useRightDockStore = create<RightDockStore>()(
  persist(
    (set) => ({
      dockStateByThreadId: {},
      openPane: (threadId, input) =>
        commit(set, threadId, (state) => openPaneInState(state, input)),
      closePane: (threadId, paneId) =>
        commit(set, threadId, (state) => closePaneInState(state, paneId)),
      setActivePane: (threadId, paneId) =>
        commit(set, threadId, (state) => setActivePaneInState(state, paneId)),
      setDockOpen: (threadId, open) =>
        commit(set, threadId, (state) => setDockOpenInState(state, open)),
      setDockWidth: (threadId, width) =>
        commit(set, threadId, (state) => setDockWidthInState(state, width)),
      updatePane: (threadId, paneId, patch) =>
        commit(set, threadId, (state) => updatePaneInState(state, paneId, patch)),
      clearThreadDockState: (threadId) =>
        set((store) => {
          if (!Object.hasOwn(store.dockStateByThreadId, threadId)) {
            return {};
          }
          const next = { ...store.dockStateByThreadId };
          delete next[threadId];
          return { dockStateByThreadId: next };
        }),
    }),
    {
      name: RIGHT_DOCK_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (store) => ({
        dockStateByThreadId: Object.fromEntries(
          Object.entries(store.dockStateByThreadId).map(([threadId, state]) => [
            threadId,
            state
              ? {
                  ...state,
                  panes: state.panes.map(
                    ({
                      appDocumentUrl: _appDocumentUrl,
                      appIconDataUrl: _appIconDataUrl,
                      appRendererId: _appRendererId,
                      ...pane
                    }) => pane,
                  ),
                }
              : state,
          ]),
        ),
      }),
      merge: (persisted, current) => ({
        ...current,
        dockStateByThreadId: sanitizeRightDockStateByThreadId(
          (persisted as { dockStateByThreadId?: unknown } | undefined)?.dockStateByThreadId,
        ),
      }),
    },
  ),
);

export function selectRightDockState(threadId: ThreadId) {
  // Keep the fallback snapshot stable so React does not observe phantom store
  // changes while mounting a thread that has no persisted dock state yet.
  return (store: RightDockStore) => store.dockStateByThreadId[threadId] ?? DEFAULT_RIGHT_DOCK_STATE;
}
