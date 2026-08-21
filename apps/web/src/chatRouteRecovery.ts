// FILE: chatRouteRecovery.ts
// Purpose: Gives route restore flows one authoritative backend refresh before falling back.
// Layer: Routing support
// Exports: empty-startup snapshot recovery helper shared by chat index and thread routes.

import type { NativeApi, OrchestrationShellSnapshot } from "@penkra/contracts";

import { EMPTY_ROUTE_RESTORE_FALLBACK_DELAY_MS } from "./chatRouteRestore";
import { useStore } from "./store";

function shellSnapshotHasProjectsOrThreads(snapshot: OrchestrationShellSnapshot): boolean {
  return snapshot.projects.length > 0 || snapshot.threads.length > 0;
}

function shellSnapshotHasThreads(snapshot: OrchestrationShellSnapshot): boolean {
  return snapshot.threads.length > 0;
}

export function waitForEmptyRouteRestoreFallbackDelay(): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, EMPTY_ROUTE_RESTORE_FALLBACK_DELAY_MS);
  });
}

// The shell projection is the authoritative route/navigation source. A full
// transcript snapshot reads the same project/thread projection rows and cannot
// make an empty shell more authoritative; using it as a fallback only turns an
// empty-state check into an unbounded history hydration.
export async function refreshEmptyRouteRestoreSnapshot(
  api: NativeApi | undefined,
): Promise<boolean> {
  if (!api) {
    return false;
  }

  const shellSnapshot = await api.orchestration.getShellSnapshot();
  if (shellSnapshotHasProjectsOrThreads(shellSnapshot)) {
    useStore.getState().syncServerShellSnapshot(shellSnapshot);
    if (shellSnapshotHasThreads(shellSnapshot)) {
      return true;
    }
    // A project-only shell is a valid empty Thread set.
  }
  return false;
}
