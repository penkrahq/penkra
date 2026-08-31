// FILE: appTabRestore.logic.ts
// Purpose: Classifies the narrow startup race where the shell loads before the App host.

import type { RightDockPane } from "../../rightDockStore.logic";

interface AppTabSpaceIdentity {
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

export function isAppTabOutsideThreadSpace(
  tab: AppTabSpaceIdentity,
  threadId: string,
  spaceId: string,
): boolean {
  return tab.threadId === threadId && tab.spaceId !== spaceId;
}

export function createAppTabRestoreRequest(pane: RightDockPane, threadId: string) {
  return {
    tabId: pane.id,
    appId: pane.appId,
    spaceId: pane.appSpaceId,
    threadId,
    route: pane.appRoute,
    ...(pane.appState === undefined ? {} : { state: pane.appState }),
  };
}
