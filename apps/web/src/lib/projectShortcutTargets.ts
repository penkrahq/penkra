import type { FolderId } from "@penkra/contracts";

import type { Project } from "../types";

function resolveUsableFolderId(
  folders: readonly Project[],
  folderId: FolderId | null,
): FolderId | null {
  if (!folderId) {
    return null;
  }

  const project = folders.find((candidate) => candidate.id === folderId);
  return project?.id ?? null;
}

export function resolveCurrentProjectTargetId(
  folders: readonly Project[],
  focusedFolderId: FolderId | null,
): FolderId | null {
  return resolveUsableFolderId(folders, focusedFolderId);
}

export function resolveLatestProjectTargetId(
  folders: readonly Project[],
  latestFolderId: FolderId | null,
): FolderId | null {
  return resolveUsableFolderId(folders, latestFolderId);
}

export function resolveLatestProjectTargetIdWithFallback(
  folders: readonly Project[],
  latestFolderId: FolderId | null,
): FolderId | null {
  return (
    resolveLatestProjectTargetId(folders, latestFolderId) ??
    folders
      .toSorted((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""))
      .at(0)?.id ??
    null
  );
}

export interface NewThreadTarget {
  readonly folderId: FolderId;
  /**
   * Whether the new thread should inherit the active surface's branch/worktree/env.
   * True only when we target the focused project; on the latest-project fallback that
   * context belongs to a project no longer in view, so we defer to its own defaults.
   */
  readonly inheritContext: boolean;
}

// Single rule for which project a global "new thread" action targets: the focused project
// when one is usable, otherwise the most recently used project. Shared by click, palette,
// and keyboard entry points so they never disagree on the fallback.
export function resolveNewThreadTarget(input: {
  currentFolderId: FolderId | null;
  latestUsableFolderId: FolderId | null;
}): NewThreadTarget | null {
  if (input.currentFolderId) {
    return { folderId: input.currentFolderId, inheritContext: true };
  }
  if (input.latestUsableFolderId) {
    return { folderId: input.latestUsableFolderId, inheritContext: false };
  }
  return null;
}
