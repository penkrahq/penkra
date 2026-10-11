// FILE: rightDockStore.logic.ts
// Purpose: Pure state transitions for App tabs in a Thread Folder's right panel.
// Layer: UI state helpers

import type { CleanCoreFolderAppTabs } from "@penkra/contracts";

export interface RightDockPane {
  id: string;
  kind: "app";
  appId: string;
  appSpaceId: string;
  appSlug: string;
  appName: string;
  // Runtime-only presentation data. This state lives in memory.
  appIconDataUrl?: string | null;
  appPresentationTitle?: string | null;
  appPresentationIconUrl?: string | null;
  appRendererId?: number;
  appDocumentUrl?: string;
  appRoute: string;
  appState?: unknown;
  appStatus: "unloaded" | "loading" | "ready" | "crashed";
}

export interface RightDockFolderState {
  open: boolean;
  panes: RightDockPane[];
  activePaneId: string | null;
  width: number | null;
}

export interface OpenPaneInput {
  preserveSelection: boolean;
  paneId: string;
  kind: "app";
  appId: string;
  appSpaceId: string;
  appSlug: string;
  appName: string;
  appIconDataUrl?: string | null;
  appPresentationTitle?: string | null;
  appPresentationIconUrl?: string | null;
  appRendererId?: number;
  appDocumentUrl?: string;
  appRoute: string;
  appState?: unknown;
  appStatus: "unloaded" | "loading" | "ready" | "crashed";
}

export function createDefaultRightDockState(): RightDockFolderState {
  return { open: false, panes: [], activePaneId: null, width: null };
}

/** Apply shared membership while keeping this window's navigation, width and runtime data. */
export function applyFolderAppTabsInState(
  state: RightDockFolderState,
  tabs: CleanCoreFolderAppTabs,
  runtimeById: Readonly<Record<string, Partial<RightDockPane> | undefined>>,
): RightDockFolderState {
  const selectedStillOpen = tabs.panes.some((pane) => pane.id === state.activePaneId);
  const previousIndex = state.panes.findIndex((pane) => pane.id === state.activePaneId);
  const activePaneId = selectedStillOpen
    ? state.activePaneId
    : state.activePaneId === null
      ? null
      : (tabs.panes[previousIndex]?.id ??
        tabs.panes[previousIndex - 1]?.id ??
        tabs.panes[0]?.id ??
        null);
  return {
    open: state.open && tabs.panes.length > 0,
    activePaneId,
    width: state.width,
    panes: tabs.panes.map((pane) => ({
      appStatus: "unloaded",
      ...runtimeById[pane.id],
      ...pane,
    })),
  };
}

export function setDockWidthInState(
  state: RightDockFolderState,
  width: number,
): RightDockFolderState {
  if (!Number.isFinite(width) || width <= 0 || state.width === width) return state;
  return { ...state, width };
}

export function updatePaneInState(
  state: RightDockFolderState,
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
): RightDockFolderState {
  let changed = false;
  const panes = state.panes.map((pane) => {
    if (pane.id !== paneId) return pane;
    const next = { ...pane, ...patch };
    if (
      next.appDocumentUrl === pane.appDocumentUrl &&
      next.appIconDataUrl === pane.appIconDataUrl &&
      next.appPresentationTitle === pane.appPresentationTitle &&
      next.appPresentationIconUrl === pane.appPresentationIconUrl &&
      next.appRendererId === pane.appRendererId &&
      next.appRoute === pane.appRoute &&
      jsonValuesEqual(next.appState, pane.appState) &&
      next.appStatus === pane.appStatus
    ) {
      return pane;
    }
    changed = true;
    return next;
  });
  return changed ? { ...state, panes } : state;
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

export function resolveActivePane(state: RightDockFolderState): RightDockPane | null {
  if (!state.open || state.activePaneId === null) return null;
  return state.panes.find((pane) => pane.id === state.activePaneId) ?? null;
}
