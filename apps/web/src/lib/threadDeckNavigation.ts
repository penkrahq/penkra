import type { ThreadId } from "@penkra/contracts";

export function canCreateAnotherDeckThread(
  members: readonly { readonly hasTurn: boolean }[],
): boolean {
  return members.every((member) => member.hasTurn);
}

export function findNearestVisibleDeckThread(input: {
  readonly threadIds: readonly ThreadId[];
  readonly removedThreadId: ThreadId;
  readonly isVisible: (threadId: ThreadId) => boolean;
}): ThreadId | null {
  const removedIndex = input.threadIds.indexOf(input.removedThreadId);
  if (removedIndex < 0) return null;

  for (let distance = 1; distance < input.threadIds.length; distance += 1) {
    const next = input.threadIds[removedIndex + distance];
    if (next && input.isVisible(next)) return next;
    const previous = input.threadIds[removedIndex - distance];
    if (previous && input.isVisible(previous)) return previous;
  }
  return null;
}

/**
 * Removes one deck member without exposing a route whose backing Thread has
 * already disappeared. Active members move to their nearest sibling first;
 * otherwise the missing-route recovery can mistake intentional removal for a
 * broken restore and bootstrap another New thread.
 */
export async function removeDeckThreadPreservingNavigation(input: {
  readonly threadIds: readonly ThreadId[];
  readonly removedThreadId: ThreadId;
  readonly activeThreadId: ThreadId;
  readonly isVisible: (threadId: ThreadId) => boolean;
  readonly activate: (threadId: ThreadId | null) => Promise<void>;
  readonly remove: (threadId: ThreadId) => Promise<void>;
}): Promise<void> {
  if (input.removedThreadId === input.activeThreadId) {
    const nearestThreadId = findNearestVisibleDeckThread(input);
    await input.activate(nearestThreadId);
  }
  await input.remove(input.removedThreadId);
}
