// FILE: projectRunStore.ts
// Purpose: Client-side projection of the server-owned dev-server registry, keyed by project id.
// Layer: Web UI state
// Exports: useProjectRunStore plus helpers for syncing dev-server lifecycle events.

import type { ProjectDevServer, FolderId } from "@penkra/contracts";

/**
 * A tracked dev server as projected from the server. This mirrors the
 * `ProjectDevServer` contract exactly — the client no longer owns thread or
 * terminal identifiers, because dev servers are first-class server processes.
 */
export type ProjectRunState = ProjectDevServer;

interface ProjectRunStoreState {
  runsByFolderId: Record<FolderId, ProjectRunState>;
  /** Replace the entire registry from an authoritative server snapshot. */
  replaceAll: (servers: ReadonlyArray<ProjectDevServer>) => void;
  /** Insert or update a single tracked dev server. */
  upsertRun: (server: ProjectDevServer) => void;
  /** Drop a tracked dev server by project id. */
  removeRun: (folderId: FolderId) => void;
}

import { create } from "zustand";

function indexByFolderId(
  servers: ReadonlyArray<ProjectDevServer>,
): Record<FolderId, ProjectRunState> {
  const next: Record<FolderId, ProjectRunState> = {};
  for (const server of servers) {
    next[server.folderId] = server;
  }
  return next;
}

export const useProjectRunStore = create<ProjectRunStoreState>((set) => ({
  runsByFolderId: {},
  replaceAll: (servers) =>
    set(() => ({
      runsByFolderId: indexByFolderId(servers),
    })),
  upsertRun: (server) =>
    set((state) => ({
      runsByFolderId: {
        ...state.runsByFolderId,
        [server.folderId]: server,
      },
    })),
  removeRun: (folderId) =>
    set((state) => {
      if (!state.runsByFolderId[folderId]) {
        return state;
      }
      const nextRunsByFolderId = { ...state.runsByFolderId };
      delete nextRunsByFolderId[folderId];
      return { runsByFolderId: nextRunsByFolderId };
    }),
}));
