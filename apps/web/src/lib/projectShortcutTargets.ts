import type { ContainerId } from "@penkra/contracts";

import type { Project } from "../types";

function resolveUsableProjectId(
  projects: readonly Project[],
  projectId: ContainerId | null,
): ContainerId | null {
  if (!projectId) {
    return null;
  }

  const project = projects.find(
    (candidate) => candidate.id === projectId && candidate.kind === "project",
  );
  return project?.id ?? null;
}

export function resolveCurrentProjectTargetId(
  projects: readonly Project[],
  focusedProjectId: ContainerId | null,
): ContainerId | null {
  return resolveUsableProjectId(projects, focusedProjectId);
}

export function resolveLatestProjectTargetId(
  projects: readonly Project[],
  latestProjectId: ContainerId | null,
): ContainerId | null {
  return resolveUsableProjectId(projects, latestProjectId);
}

export function resolveLatestProjectTargetIdWithFallback(
  projects: readonly Project[],
  latestProjectId: ContainerId | null,
): ContainerId | null {
  return (
    resolveLatestProjectTargetId(projects, latestProjectId) ??
    projects
      .filter((project) => project.kind === "project")
      .toSorted((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""))
      .at(0)?.id ??
    null
  );
}

export interface NewThreadTarget {
  readonly projectId: ContainerId;
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
  currentProjectId: ContainerId | null;
  latestUsableProjectId: ContainerId | null;
}): NewThreadTarget | null {
  if (input.currentProjectId) {
    return { projectId: input.currentProjectId, inheritContext: true };
  }
  if (input.latestUsableProjectId) {
    return { projectId: input.latestUsableProjectId, inheritContext: false };
  }
  return null;
}
