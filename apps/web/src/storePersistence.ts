// FILE: storePersistence.ts
// Purpose: Persists project-only renderer preferences without depending on the Zustand facade.
// Exports: Persistence I/O plus read-only remembered project UI state.

import { normalizeWorkspaceRootForComparison } from "@penkra/shared/threadWorkspace";

import type { AppState } from "./storeState";
import type { Project } from "./types";

const PERSISTED_STATE_KEY = "penkra:renderer-state:v9";
const persistedExpandedProjectIds = new Set<string>();
const persistedProjectOrderIds: string[] = [];
const persistedProjectOrderById = new Map<string, number>();
const persistedProjectNamesById = new Map<string, string>();

export interface RememberedProjectUiState {
  expandedProjectCount: number;
  isProjectExpanded: (projectId: string) => boolean;
  projectOrderCount: number;
  projectOrderIndexForId: (projectId: string) => number | undefined;
  projectNameForId: (projectId: string) => string | undefined;
}

const rememberedProjectUiState: RememberedProjectUiState = {
  get expandedProjectCount() {
    return persistedExpandedProjectIds.size;
  },
  isProjectExpanded: (projectId) => persistedExpandedProjectIds.has(projectId),
  get projectOrderCount() {
    return persistedProjectOrderIds.length;
  },
  projectOrderIndexForId: (projectId) => persistedProjectOrderById.get(projectId),
  projectNameForId: (projectId) => persistedProjectNamesById.get(projectId),
};

export function projectCwdKey(cwd: string): string {
  return normalizeWorkspaceRootForComparison(cwd);
}

export function getRememberedProjectUiState(): RememberedProjectUiState {
  return rememberedProjectUiState;
}

export function rememberProjectUiState(
  projects: ReadonlyArray<Pick<Project, "id" | "expanded">>,
): void {
  for (const project of projects) {
    const projectId = project.id;
    if (project.expanded) {
      persistedExpandedProjectIds.add(projectId);
    } else {
      persistedExpandedProjectIds.delete(projectId);
    }
    if (!persistedProjectOrderById.has(projectId)) {
      persistedProjectOrderById.set(projectId, persistedProjectOrderIds.length);
      persistedProjectOrderIds.push(projectId);
    }
  }
}

export function rememberProjectLocalNames(
  projects: ReadonlyArray<Pick<Project, "id" | "localName">>,
): void {
  for (const project of projects) {
    const projectId = project.id;
    const localName = project.localName?.trim() ?? "";
    if (localName.length > 0) {
      persistedProjectNamesById.set(projectId, localName);
    } else {
      persistedProjectNamesById.delete(projectId);
    }
  }
}

export function readPersistedState(initialState: AppState): AppState {
  if (typeof window === "undefined") return initialState;
  try {
    const raw = window.localStorage.getItem(PERSISTED_STATE_KEY);
    if (!raw) return initialState;
    const parsed = JSON.parse(raw) as {
      expandedProjectIds?: string[];
      projectOrderIds?: string[];
      projectNamesById?: Record<string, string>;
    };
    persistedExpandedProjectIds.clear();
    persistedProjectOrderIds.length = 0;
    persistedProjectOrderById.clear();
    persistedProjectNamesById.clear();
    for (const projectId of parsed.expandedProjectIds ?? []) {
      if (typeof projectId === "string" && projectId.length > 0) {
        persistedExpandedProjectIds.add(projectId);
      }
    }
    for (const projectId of parsed.projectOrderIds ?? []) {
      if (
        typeof projectId === "string" &&
        projectId.length > 0 &&
        !persistedProjectOrderById.has(projectId)
      ) {
        persistedProjectOrderById.set(projectId, persistedProjectOrderIds.length);
        persistedProjectOrderIds.push(projectId);
      }
    }
    for (const [projectId, name] of Object.entries(parsed.projectNamesById ?? {})) {
      if (projectId.length === 0 || typeof name !== "string") continue;
      const trimmedName = name.trim();
      if (trimmedName.length === 0) continue;
      persistedProjectNamesById.set(projectId, trimmedName);
    }
    return { ...initialState };
  } catch {
    return initialState;
  }
}

export function persistState(state: AppState): void {
  if (typeof window === "undefined") return;
  try {
    rememberProjectUiState(state.projects);
    rememberProjectLocalNames(state.projects);
    window.localStorage.setItem(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        expandedProjectIds: state.projects
          .filter((project) => project.expanded)
          .map((project) => project.id),
        projectOrderIds: state.projects.map((project) => project.id),
        projectNamesById: Object.fromEntries(persistedProjectNamesById),
      }),
    );
  } catch {
    // Ignore quota/storage errors to avoid breaking chat UX.
  }
}
