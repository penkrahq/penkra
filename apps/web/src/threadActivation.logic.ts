// FILE: threadActivation.logic.ts
// Purpose: Pure routing decisions for opening threads.
// Exports: activation resolvers shared by sidebar click, keyboard, and search flows.

import type { ThreadId } from "@penkra/contracts";

export type ThreadCommandActivation = { kind: "ignore" } | { kind: "single"; threadId: ThreadId };

type PointerActivationIntent = {
  altKey: boolean;
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
};

/** Shared press policy for thread controls that combine activation with drag or selection. */
export function isPrimaryThreadActivationIntent(intent: PointerActivationIntent): boolean {
  return (
    intent.button === 0 && !intent.altKey && !intent.ctrlKey && !intent.metaKey && !intent.shiftKey
  );
}

/**
 * Decide what a sidebar/search/keyboard activation should do for a thread.
 *
 */
export function resolveThreadCommandActivation(input: {
  threadId: ThreadId;
  threadExists: boolean;
  activeSidebarThreadId: ThreadId | null | undefined;
}): ThreadCommandActivation {
  if (!input.threadExists) {
    return { kind: "ignore" };
  }

  if (input.threadId === input.activeSidebarThreadId) {
    return { kind: "ignore" };
  }

  return { kind: "single", threadId: input.threadId };
}
