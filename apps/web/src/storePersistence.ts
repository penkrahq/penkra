// FILE: storePersistence.ts
// Purpose: Persists project-only renderer preferences without depending on the Zustand facade.
// Exports: Persistence I/O plus read-only remembered project UI state.

import { normalizeWorkspaceRootForComparison } from "@penkra/shared/threadWorkspace";

import type { AppState } from "./storeState";
import type { Project } from "./types";

const PERSISTED_STATE_KEY = "penkra:renderer-state:v9";
const persistedExpandedFolderIds = new Set<string>();
const persistedProjectOrderIds: string[] = [];
const persistedProjectOrderById = new Map<string, number>();
const persistedProjectNamesById = new Map<string, string>();

export interface RememberedProjectUiState {
  expandedProjectCount: number;
  isProjectExpanded: (folderId: string) => boolean;
  projectOrderCount: number;
  projectOrderIndexForId: (folderId: string) => number | undefined;
  projectNameForId: (folderId: string) => string | undefined;
}

const rememberedProjectUiState: RememberedProjectUiState = {
  get expandedProjectCount() {
    return persistedExpandedFolderIds.size;
  },
  isProjectExpanded: (folderId) => persistedExpandedFolderIds.has(folderId),
  get projectOrderCount() {
    return persistedProjectOrderIds.length;
  },
  projectOrderIndexForId: (folderId) => persistedProjectOrderById.get(folderId),
  projectNameForId: (folderId) => persistedProjectNamesById.get(folderId),
};

export function projectCwdKey(cwd: string): string {
  return normalizeWorkspaceRootForComparison(cwd);
}

export function getRememberedProjectUiState(): RememberedProjectUiState {
  return rememberedProjectUiState;
}

export function rememberProjectUiState(
  folders: ReadonlyArray<Pick<Project, "id" | "expanded">>,
): void {
  for (const project of folders) {
    const folderId = project.id;
    if (project.expanded) {
      persistedExpandedFolderIds.add(folderId);
    } else {
      persistedExpandedFolderIds.delete(folderId);
    }
    if (!persistedProjectOrderById.has(folderId)) {
      persistedProjectOrderById.set(folderId, persistedProjectOrderIds.length);
      persistedProjectOrderIds.push(folderId);
    }
  }
}

export function rememberProjectLocalNames(
  folders: ReadonlyArray<Pick<Project, "id" | "localName">>,
): void {
  for (const project of folders) {
    const folderId = project.id;
    const localName = project.localName?.trim() ?? "";
    if (localName.length > 0) {
      persistedProjectNamesById.set(folderId, localName);
    } else {
      persistedProjectNamesById.delete(folderId);
    }
  }
}

export function readPersistedState(initialState: AppState): AppState {
  if (typeof window === "undefined") return initialState;
  try {
    const raw = window.localStorage.getItem(PERSISTED_STATE_KEY);
    if (!raw) return initialState;
    const parsed = JSON.parse(raw) as {
      expandedFolderIds?: string[];
      projectOrderIds?: string[];
      projectNamesById?: Record<string, string>;
    };
    persistedExpandedFolderIds.clear();
    persistedProjectOrderIds.length = 0;
    persistedProjectOrderById.clear();
    persistedProjectNamesById.clear();
    for (const folderId of parsed.expandedFolderIds ?? []) {
      if (typeof folderId === "string" && folderId.length > 0) {
        persistedExpandedFolderIds.add(folderId);
      }
    }
    for (const folderId of parsed.projectOrderIds ?? []) {
      if (
        typeof folderId === "string" &&
        folderId.length > 0 &&
        !persistedProjectOrderById.has(folderId)
      ) {
        persistedProjectOrderById.set(folderId, persistedProjectOrderIds.length);
        persistedProjectOrderIds.push(folderId);
      }
    }
    for (const [folderId, name] of Object.entries(parsed.projectNamesById ?? {})) {
      if (folderId.length === 0 || typeof name !== "string") continue;
      const trimmedName = name.trim();
      if (trimmedName.length === 0) continue;
      persistedProjectNamesById.set(folderId, trimmedName);
    }
    return { ...initialState };
  } catch {
    return initialState;
  }
}

export function persistState(state: AppState): void {
  if (typeof window === "undefined") return;
  try {
    rememberProjectUiState(state.folders);
    rememberProjectLocalNames(state.folders);
    window.localStorage.setItem(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        expandedFolderIds: state.folders
          .filter((project) => project.expanded)
          .map((project) => project.id),
        projectOrderIds: state.folders.map((project) => project.id),
        projectNamesById: Object.fromEntries(persistedProjectNamesById),
      }),
    );
  } catch {
    // Ignore quota/storage errors to avoid breaking chat UX.
  }
}
