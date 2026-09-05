// FILE: threadReadAcknowledgement.ts
// Purpose: Keeps a manual unread marker stable until the currently viewed Thread is exited.

const deferredThreadIds = new Set<string>();

export function deferThreadReadAcknowledgementIfActive(
  threadId: string,
  activeThreadId: string | null,
): boolean {
  if (threadId !== activeThreadId) return false;
  deferredThreadIds.add(threadId);
  return true;
}

export function isThreadReadAcknowledgementDeferred(threadId: string): boolean {
  return deferredThreadIds.has(threadId);
}

export function releaseThreadReadAcknowledgement(threadId: string): void {
  deferredThreadIds.delete(threadId);
}
