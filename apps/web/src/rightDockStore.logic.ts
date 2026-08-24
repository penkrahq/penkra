// FILE: rightDockStore.logic.ts
// Purpose: Pure state transitions for App tabs in the Thread's right panel.
// Layer: UI state helpers

import { isPlainObject, sanitizeStringKeyedRecord } from "./persistedRecord";

export interface RightDockPane {
  id: string;
  kind: "app";
  appId: string;
  appSlug: string;
  appName: string;
  // Runtime-only presentation data. Persistence deliberately strips it.
  appIconDataUrl?: string | null;
  appRendererId?: number;
  appDocumentUrl?: string;
  appRoute: string;
  appState?: unknown;
  appStatus: "loading" | "ready" | "crashed";
}

export interface RightDockThreadState {
  open: boolean;
  panes: RightDockPane[];
  activePaneId: string | null;
  width: number | null;
}

export interface OpenPaneInput {
  paneId: string;
  kind: "app";
  appId: string;
  appSlug: string;
  appName: string;
  appIconDataUrl?: string | null;
  appRendererId?: number;
  appDocumentUrl?: string;
  appRoute: string;
  appState?: unknown;
  appStatus: "loading" | "ready" | "crashed";
}

export function createDefaultRightDockState(): RightDockThreadState {
  return { open: false, panes: [], activePaneId: null, width: null };
}

function parsePersistedAppPane(value: unknown): RightDockPane | null {
  if (!isPlainObject(value) || value.kind !== "app") return null;
  if (
    typeof value.id !== "string" ||
    typeof value.appId !== "string" ||
    typeof value.appSlug !== "string" ||
    typeof value.appName !== "string" ||
    typeof value.appRoute !== "string" ||
    (value.appStatus !== "loading" && value.appStatus !== "ready" && value.appStatus !== "crashed")
  ) {
    return null;
  }
  return {
    id: value.id,
    kind: "app",
    appId: value.appId,
    appSlug: value.appSlug,
    appName: value.appName,
    appRoute: value.appRoute,
    ...(value.appState === undefined ? {} : { appState: value.appState }),
    appStatus: value.appStatus,
  };
}

export function sanitizeRightDockThreadState(value: unknown): RightDockThreadState {
  if (!isPlainObject(value)) return createDefaultRightDockState();
  const panes = Array.isArray(value.panes)
    ? value.panes.map(parsePersistedAppPane).filter((pane): pane is RightDockPane => pane !== null)
    : [];
  const activePaneId =
    typeof value.activePaneId === "string" && panes.some((pane) => pane.id === value.activePaneId)
      ? value.activePaneId
      : (panes[0]?.id ?? null);
  const width =
    typeof value.width === "number" && Number.isFinite(value.width) && value.width > 0
      ? value.width
      : null;
  return { open: value.open === true && panes.length > 0, panes, activePaneId, width };
}

export function sanitizeRightDockStateByThreadId(
  value: unknown,
): Record<string, RightDockThreadState> {
  return sanitizeStringKeyedRecord(value, (raw) =>
    raw === undefined ? null : sanitizeRightDockThreadState(raw),
  );
}

function createPane(input: OpenPaneInput): RightDockPane {
  return {
    id: input.paneId,
    kind: "app",
    appId: input.appId,
    appSlug: input.appSlug,
    appName: input.appName,
    ...(input.appIconDataUrl === undefined ? {} : { appIconDataUrl: input.appIconDataUrl }),
    ...(input.appRendererId === undefined ? {} : { appRendererId: input.appRendererId }),
    ...(input.appDocumentUrl === undefined ? {} : { appDocumentUrl: input.appDocumentUrl }),
    appRoute: input.appRoute,
    ...(input.appState === undefined ? {} : { appState: input.appState }),
    appStatus: input.appStatus,
  };
}

export function openPaneInState(
  state: RightDockThreadState,
  input: OpenPaneInput,
): RightDockThreadState {
  const existing = state.panes.find((pane) => pane.id === input.paneId);
  if (existing) {
    const pane = createPane(input);
    const panes = state.panes.map((candidate) =>
      candidate.id === input.paneId ? pane : candidate,
    );
    return { ...state, open: true, panes, activePaneId: existing.id };
  }
  const pane = createPane(input);
  return { ...state, open: true, panes: [...state.panes, pane], activePaneId: pane.id };
}

export function closePaneInState(
  state: RightDockThreadState,
  paneId: string,
): RightDockThreadState {
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
  state: RightDockThreadState,
  paneId: string,
): RightDockThreadState {
  if (!state.panes.some((pane) => pane.id === paneId)) return state;
  return { ...state, open: true, activePaneId: paneId };
}

export function setDockOpenInState(
  state: RightDockThreadState,
  open: boolean,
): RightDockThreadState {
  const nextOpen = open && state.panes.length > 0;
  return state.open === nextOpen ? state : { ...state, open: nextOpen };
}

export function setDockWidthInState(
  state: RightDockThreadState,
  width: number,
): RightDockThreadState {
  if (!Number.isFinite(width) || width <= 0 || state.width === width) return state;
  return { ...state, width };
}

export function updatePaneInState(
  state: RightDockThreadState,
  paneId: string,
  patch: Partial<
    Pick<
      RightDockPane,
      "appDocumentUrl" | "appIconDataUrl" | "appRendererId" | "appRoute" | "appState" | "appStatus"
    >
  >,
): RightDockThreadState {
  let changed = false;
  const panes = state.panes.map((pane) => {
    if (pane.id !== paneId) return pane;
    const next = { ...pane, ...patch };
    if (
      next.appDocumentUrl === pane.appDocumentUrl &&
      next.appIconDataUrl === pane.appIconDataUrl &&
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

export function resolveActivePane(state: RightDockThreadState): RightDockPane | null {
  if (!state.open || state.activePaneId === null) return null;
  return state.panes.find((pane) => pane.id === state.activePaneId) ?? null;
}
