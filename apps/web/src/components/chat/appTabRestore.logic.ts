// FILE: appTabRestore.logic.ts
// Purpose: Classifies the narrow startup race where the shell loads before the native App host.

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
