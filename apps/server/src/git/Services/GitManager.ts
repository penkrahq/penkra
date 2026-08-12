/**
 * GitManager - Effect service contract for stacked Git workflows.
 *
 * Orchestrates status inspection and commit/push/PR flows by composing
 * lower-level Git and external tool services.
 *
 * @module GitManager
 */
import {
  GitSwitchThreadEnvironmentInput,
  GitSwitchThreadEnvironmentResult,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitPullRequestRefInput,
  GitPullRequestSnapshotInput,
  GitPullRequestSnapshotResult,
  GitReadWorkingTreeDiffInput,
  GitReadWorkingTreeDiffResult,
  GitWorkingTreeDiffStatsResult,
  GitResolvePullRequestResult,
  GitStatusInput,
  GitStatusResult,
} from "@penkra/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";
import type { GitManagerServiceError } from "../Errors.ts";

/**
 * GitManagerShape - Service API for high-level Git workflow actions.
 */
export interface GitManagerShape {
  /**
   * Read current repository Git status plus open PR metadata when available.
   */
  readonly status: (
    input: GitStatusInput,
  ) => Effect.Effect<GitStatusResult, GitManagerServiceError>;

  /**
   * Read a unified patch for the current repository working tree.
   */
  readonly readWorkingTreeDiff: (
    input: GitReadWorkingTreeDiffInput,
  ) => Effect.Effect<GitReadWorkingTreeDiffResult, GitManagerServiceError>;

  /**
   * Count the lines a scope's patch changes without returning the patch text.
   */
  readonly readWorkingTreeDiffStats: (
    input: GitReadWorkingTreeDiffInput,
  ) => Effect.Effect<GitWorkingTreeDiffStatsResult, GitManagerServiceError>;

  /**
   * Resolve a pull request by URL/number against the current repository.
   */
  readonly resolvePullRequest: (
    input: GitPullRequestRefInput,
  ) => Effect.Effect<GitResolvePullRequestResult, GitManagerServiceError>;

  /**
   * Load live CI checks and top-level review comments for a pull request.
   */
  readonly pullRequestSnapshot: (
    input: GitPullRequestSnapshotInput,
  ) => Effect.Effect<GitPullRequestSnapshotResult, GitManagerServiceError>;

  /**
   * Prepare a new thread workspace from a pull request in local or worktree mode.
   */
  readonly preparePullRequestThread: (
    input: GitPreparePullRequestThreadInput,
  ) => Effect.Effect<GitPreparePullRequestThreadResult, GitManagerServiceError>;

  /**
   * Move a thread between Local and Worktree while preserving recoverable Git state.
   */
  readonly switchThreadEnvironment: (
    input: Omit<GitSwitchThreadEnvironmentInput, "commandId" | "threadId">,
  ) => Effect.Effect<GitSwitchThreadEnvironmentResult, GitManagerServiceError>;
}

/**
 * GitManager - Service tag for stacked Git workflow orchestration.
 */
export class GitManager extends ServiceMap.Service<GitManager, GitManagerShape>()(
  "penkra/git/Services/GitManager",
) {}
