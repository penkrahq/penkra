// FILE: chatThreadRoute.logic.ts
// Purpose: Keep Thread route state transitions and workspace resolution deterministic.
// Layer: Route UI logic helpers.
// Exports: Thread title fallback, working-directory resolution, and split-view decisions.

import type { FolderId, ThreadId } from "@penkra/contracts";
import { resolveThreadWorkspaceCwd } from "@penkra/shared/threadEnvironment";

export interface SplitPaneMaximizeDecision {
  splitViewIdToRemove: string;
  threadId: ThreadId;
}

export type SplitPaneCloseDecision =
  | {
      kind: "single-thread";
      threadId: ThreadId;
      splitViewIdToRemove: string;
    }
  | {
      kind: "split-thread";
      threadId: ThreadId;
      splitViewId: string;
    }
  | {
      kind: "new-chat";
    };

export function resolveThreadPickerTitle(title: string | null): string {
  return title || "New chat";
}

export function resolveThreadWorkingDirectory(input: {
  projectCwd?: string | null | undefined;
  threadWorkingDirectory?: string | null | undefined;
}): string | null {
  return resolveThreadWorkspaceCwd({
    projectCwd: input.projectCwd,
    workingDirectory: input.threadWorkingDirectory,
  });
}

export function resolveSingleFolderId(input: {
  threadFolderId: FolderId | null;
  draftFolderId: FolderId | null;
}): FolderId | null {
  return input.threadFolderId ?? input.draftFolderId ?? null;
}

// Expanding a split pane exits split mode entirely; the selected chat becomes the single surface.
export function resolveSplitPaneMaximizeDecision(input: {
  splitViewId: string;
  focusedThreadId: ThreadId | null | undefined;
}): SplitPaneMaximizeDecision | null {
  if (!input.focusedThreadId) {
    return null;
  }

  return {
    splitViewIdToRemove: input.splitViewId,
    threadId: input.focusedThreadId,
  };
}

export function resolveSplitPaneCloseDecision(input: {
  splitViewId: string;
  sourceThreadId: ThreadId;
  closingThreadId: ThreadId | null | undefined;
  nextFocusedThreadId: ThreadId | null | undefined;
  nextLeafCount: number;
}): SplitPaneCloseDecision {
  if (input.closingThreadId && input.closingThreadId !== input.sourceThreadId) {
    return {
      kind: "single-thread",
      threadId: input.sourceThreadId,
      splitViewIdToRemove: input.splitViewId,
    };
  }

  if (input.nextFocusedThreadId) {
    if (input.nextLeafCount <= 1) {
      return {
        kind: "single-thread",
        threadId: input.nextFocusedThreadId,
        splitViewIdToRemove: input.splitViewId,
      };
    }
    return {
      kind: "split-thread",
      threadId: input.nextFocusedThreadId,
      splitViewId: input.splitViewId,
    };
  }

  return { kind: "new-chat" };
}
