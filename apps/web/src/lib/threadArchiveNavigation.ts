import type { ThreadId } from "@penkra/contracts";

// Scoped to one renderer window. The window performing an archive already chooses
// its fallback route; other windows react to the archived shell independently.
const locallyArchivingThreadIds = new Set<ThreadId>();

export function beginLocalThreadArchiveNavigation(threadId: ThreadId): void {
  locallyArchivingThreadIds.add(threadId);
}

export function endLocalThreadArchiveNavigation(threadId: ThreadId): void {
  locallyArchivingThreadIds.delete(threadId);
}

export function isLocalThreadArchiveNavigationPending(threadId: ThreadId): boolean {
  return locallyArchivingThreadIds.has(threadId);
}
