// FILE: appTabRestore.logic.ts
// Purpose: Classifies the narrow startup race where the shell loads before the App host.

import type { DesktopAppTabDescriptor } from "@penkra/contracts";

import type { RightDockPane } from "../../rightDockStore.logic";

interface AppTabSpaceIdentity {
  folderId: string;
  threadId: string;
  spaceId: string;
}

export const APP_TAB_HOST_READY_RETRY_LIMIT = 50;

export function shouldRetryAppTabHostReady(error: unknown, attempt: number): boolean {
  return (
    attempt < APP_TAB_HOST_READY_RETRY_LIMIT &&
    error instanceof Error &&
    error.message.includes("The App tab host is not ready")
  );
}

export function shouldMountAppDockPane(
  tabId: string,
  confirmedTabIds: ReadonlySet<string>,
): boolean {
  return confirmedTabIds.has(tabId);
}

export function isAppPaneInSpace(pane: RightDockPane, spaceId: string): boolean {
  return pane.appSpaceId === spaceId;
}

export function isAppTabOutsideFolderSpace(
  tab: AppTabSpaceIdentity,
  folderId: string,
  spaceId: string,
): boolean {
  return tab.folderId === folderId && tab.spaceId !== spaceId;
}

export function createAppTabRestoreRequest(
  pane: RightDockPane,
  folderId: string,
  threadId: string,
) {
  return {
    tabId: pane.id,
    appId: pane.appId,
    spaceId: pane.appSpaceId,
    folderId,
    threadId,
    route: pane.appRoute,
    ...(pane.appState === undefined ? {} : { state: pane.appState }),
  };
}

/** Renderer reload does not close native App tabs. Adopt the retained tab before creating one. */
export async function restoreAppTab(
  pane: RightDockPane,
  folderId: string,
  threadId: string,
  bridge: {
    list: () => Promise<readonly DesktopAppTabDescriptor[]>;
    open: (
      input: ReturnType<typeof createAppTabRestoreRequest>,
    ) => Promise<DesktopAppTabDescriptor>;
  },
): Promise<DesktopAppTabDescriptor> {
  const request = createAppTabRestoreRequest(pane, folderId, threadId);
  const retained = (tabs: readonly DesktopAppTabDescriptor[]) => {
    const tab = tabs.find((candidate) => candidate.id === pane.id);
    if (
      tab &&
      (tab.appId !== pane.appId ||
        tab.spaceId !== pane.appSpaceId ||
        tab.folderId !== folderId ||
        tab.threadId !== threadId)
    ) {
      throw new Error(`App tab ${pane.id} belongs to a different Thread or Space.`);
    }
    return tab;
  };
  const existing = retained(await bridge.list());
  if (existing) return existing;
  try {
    return await bridge.open(request);
  } catch (error) {
    // Another shell may have restored the same tab between list and open.
    const raced = retained(await bridge.list().catch(() => []));
    if (raced) return raced;
    throw error;
  }
}
