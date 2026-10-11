// FILE: rightDockStore.logic.ts
// Purpose: Pure state transitions for App tabs in a Thread Folder's right panel.
// Layer: UI state helpers

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
  preserveSelection?: boolean;
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

function createPane(input: OpenPaneInput): RightDockPane {
  return {
    id: input.paneId,
    kind: "app",
    appId: input.appId,
    appSpaceId: input.appSpaceId,
    appSlug: input.appSlug,
    appName: input.appName,
    ...(input.appIconDataUrl === undefined ? {} : { appIconDataUrl: input.appIconDataUrl }),
    ...(input.appPresentationTitle === undefined
      ? {}
      : { appPresentationTitle: input.appPresentationTitle }),
    ...(input.appPresentationIconUrl === undefined
      ? {}
      : { appPresentationIconUrl: input.appPresentationIconUrl }),
    ...(input.appRendererId === undefined ? {} : { appRendererId: input.appRendererId }),
    ...(input.appDocumentUrl === undefined ? {} : { appDocumentUrl: input.appDocumentUrl }),
    appRoute: input.appRoute,
    ...(input.appState === undefined ? {} : { appState: input.appState }),
    appStatus: input.appStatus,
  };
}

export function openPaneInState(
  state: RightDockFolderState,
  input: OpenPaneInput,
): RightDockFolderState {
  const existing = state.panes.find((pane) => pane.id === input.paneId);
  if (existing) {
    const pane = createPane(input);
    const panes = state.panes.map((candidate) =>
      candidate.id === input.paneId ? pane : candidate,
    );
    return input.preserveSelection
      ? { ...state, panes }
      : { ...state, open: true, panes, activePaneId: existing.id };
  }
  const pane = createPane(input);
  return input.preserveSelection
    ? { ...state, panes: [...state.panes, pane] }
    : { ...state, open: true, panes: [...state.panes, pane], activePaneId: pane.id };
}

export function closePaneInState(
  state: RightDockFolderState,
  paneId: string,
): RightDockFolderState {
  const removedIndex = state.panes.findIndex((pane) => pane.id === paneId);
  if (removedIndex === -1) return state;
  const panes = state.panes.filter((pane) => pane.id !== paneId);
  const activePaneId =
    state.activePaneId === paneId
      ? (panes[Math.min(removedIndex, panes.length - 1)]?.id ?? null)
      : state.activePaneId;
  return { ...state, open: panes.length > 0 && state.open, panes, activePaneId };
}

export function setActivePaneInState(
  state: RightDockFolderState,
  paneId: string,
): RightDockFolderState {
  if (!state.panes.some((pane) => pane.id === paneId)) return state;
  return { ...state, open: true, activePaneId: paneId };
}

export function setDockOpenInState(
  state: RightDockFolderState,
  open: boolean,
): RightDockFolderState {
  const nextOpen = open && state.panes.length > 0;
  return state.open === nextOpen ? state : { ...state, open: nextOpen };
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
