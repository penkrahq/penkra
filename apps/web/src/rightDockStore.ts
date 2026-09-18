// FILE: rightDockStore.ts
// Purpose: Persist App-tab state per Thread Deck.
// Layer: UI state store
// Exports: dock store hook, per-deck selector, one-time legacy migration, and stable default snapshot.

import type { ThreadDeckId, ThreadId } from "@penkra/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import {
  type OpenPaneInput,
  type RightDockPane,
  type RightDockDeckState,
  closePaneInState,
  createDefaultRightDockState,
  openPaneInState,
  migrateRightDockStateByThreadId,
  sanitizeRightDockStateByDeckId,
  setActivePaneInState,
  setDockOpenInState,
  setDockWidthInState,
  updatePaneInState,
} from "./rightDockStore.logic";

const RIGHT_DOCK_STORAGE_KEY = "penkra:app-tabs-by-deck:v3";
const PREVIOUS_RIGHT_DOCK_STORAGE_KEY = "penkra:app-tabs-by-deck:v2";
const LEGACY_RIGHT_DOCK_STORAGE_KEY = "penkra:app-tabs-by-thread:v1";

interface RightDockStore {
  dockStateByDeckId: Record<string, RightDockDeckState | undefined>;
  openPane: (deckId: ThreadDeckId, input: OpenPaneInput) => void;
  closePane: (deckId: ThreadDeckId, paneId: string) => void;
  setActivePane: (deckId: ThreadDeckId, paneId: string) => void;
  setDockOpen: (deckId: ThreadDeckId, open: boolean) => void;
  setDockWidth: (deckId: ThreadDeckId, width: number) => void;
  updatePane: (
    deckId: ThreadDeckId,
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
  clearDeckDockState: (deckId: ThreadDeckId) => void;
}

// Frozen shared snapshot: it is handed back from `selectRightDockState` for any
// thread without persisted dock state, so it must stay a stable, immutable
// reference (transitions always build new objects rather than mutating it).
const DEFAULT_RIGHT_DOCK_STATE = createDefaultRightDockState();
Object.freeze(DEFAULT_RIGHT_DOCK_STATE);
Object.freeze(DEFAULT_RIGHT_DOCK_STATE.panes);

function commit(
  set: (fn: (store: RightDockStore) => Partial<RightDockStore>) => void,
  deckId: ThreadDeckId,
  transform: (state: RightDockDeckState) => RightDockDeckState,
): void {
  set((store) => {
    const previous = store.dockStateByDeckId[deckId] ?? DEFAULT_RIGHT_DOCK_STATE;
    const next = transform(previous);
    if (next === previous) {
      return {};
    }
    return {
      dockStateByDeckId: {
        ...store.dockStateByDeckId,
        [deckId]: next,
      },
    };
  });
}

export const useRightDockStore = create<RightDockStore>()(
  persist(
    (set) => ({
      dockStateByDeckId: {},
      openPane: (deckId, input) => commit(set, deckId, (state) => openPaneInState(state, input)),
      closePane: (deckId, paneId) =>
        commit(set, deckId, (state) => closePaneInState(state, paneId)),
      setActivePane: (deckId, paneId) =>
        commit(set, deckId, (state) => setActivePaneInState(state, paneId)),
      setDockOpen: (deckId, open) =>
        commit(set, deckId, (state) => setDockOpenInState(state, open)),
      setDockWidth: (deckId, width) =>
        commit(set, deckId, (state) => setDockWidthInState(state, width)),
      updatePane: (deckId, paneId, patch) =>
        commit(set, deckId, (state) => updatePaneInState(state, paneId, patch)),
      clearDeckDockState: (deckId) =>
        set((store) => {
          if (!Object.hasOwn(store.dockStateByDeckId, deckId)) {
            return {};
          }
          const next = { ...store.dockStateByDeckId };
          delete next[deckId];
          return { dockStateByDeckId: next };
        }),
    }),
    {
      name: RIGHT_DOCK_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (store) => ({
        dockStateByDeckId: Object.fromEntries(
          Object.entries(store.dockStateByDeckId).map(([deckId, state]) => [
            deckId,
            state
              ? {
                  ...state,
                  panes: state.panes.map(
                    ({
                      appDocumentUrl: _appDocumentUrl,
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
        dockStateByDeckId: sanitizeRightDockStateByDeckId(
          (persisted as { dockStateByDeckId?: unknown } | undefined)?.dockStateByDeckId,
        ),
      }),
    },
  ),
);

export function migrateLegacyRightDockStorage(
  deckIdByThreadId: ReadonlyMap<ThreadId, ThreadDeckId>,
): void {
  const previous = localStorage.getItem(PREVIOUS_RIGHT_DOCK_STORAGE_KEY);
  if (previous && !localStorage.getItem(RIGHT_DOCK_STORAGE_KEY)) {
    try {
      const parsed = JSON.parse(previous) as { state?: { dockStateByDeckId?: unknown } };
      useRightDockStore.setState((store) => ({
        dockStateByDeckId: {
          ...sanitizeRightDockStateByDeckId(parsed.state?.dockStateByDeckId),
          ...store.dockStateByDeckId,
        },
      }));
    } catch {
      // Invalid prior state is discarded below.
    }
  }
  localStorage.removeItem(PREVIOUS_RIGHT_DOCK_STORAGE_KEY);
  const serialized = localStorage.getItem(LEGACY_RIGHT_DOCK_STORAGE_KEY);
  if (!serialized) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    localStorage.removeItem(LEGACY_RIGHT_DOCK_STORAGE_KEY);
    return;
  }
  const persistedState =
    parsed && typeof parsed === "object" && "state" in parsed
      ? (parsed as { state?: unknown }).state
      : parsed;
  const legacyRecord =
    persistedState && typeof persistedState === "object" && "dockStateByThreadId" in persistedState
      ? (persistedState as { dockStateByThreadId?: unknown }).dockStateByThreadId
      : undefined;
  const migratedByDeckId = migrateRightDockStateByThreadId(legacyRecord, deckIdByThreadId);
  useRightDockStore.setState((store) => ({
    dockStateByDeckId: {
      ...migratedByDeckId,
      ...store.dockStateByDeckId,
    },
  }));
  localStorage.removeItem(LEGACY_RIGHT_DOCK_STORAGE_KEY);
}

export function selectRightDockState(deckId: ThreadDeckId) {
  // Keep the fallback snapshot stable so React does not observe phantom store
  // changes while mounting a thread that has no persisted dock state yet.
  return (store: RightDockStore) => store.dockStateByDeckId[deckId] ?? DEFAULT_RIGHT_DOCK_STATE;
}
