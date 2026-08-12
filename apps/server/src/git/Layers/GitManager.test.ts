import fs from "node:fs";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, PlatformError, Scope } from "effect";
import { expect } from "vitest";
import type { GitPullRequestCheck, GitPullRequestComment } from "@penkra/contracts";

import { GitCommandError, GitHubCliError } from "../Errors.ts";
import { type GitManagerShape } from "../Services/GitManager.ts";
import { GitHubCli, PULL_REQUEST_SUMMARY_JSON_FIELDS } from "../Services/GitHubCli.ts";
import { GitCoreLive } from "./GitCore.ts";
import { GitCore } from "../Services/GitCore.ts";
import { createGitHubCliWithFakeGh, type FakeGhScenario } from "../testing/fakeGitHubCli.ts";
import { makeGitManager } from "./GitManager.ts";
import { ServerConfig } from "../../config.ts";

function makeTempDir(
  prefix: string,
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });
}

function runGit(
  cwd: string,
  args: readonly string[],
  allowNonZeroExit = false,
): Effect.Effect<
  { readonly code: number; readonly stdout: string; readonly stderr: string },
  GitCommandError,
  GitCore
> {
  return Effect.gen(function* () {
    const gitCore = yield* GitCore;
    return yield* gitCore.execute({
      operation: "GitManager.test.runGit",
      cwd,
      args,
      allowNonZeroExit,
    });
  });
}

function initRepo(
  cwd: string,
): Effect.Effect<
  void,
  PlatformError.PlatformError | GitCommandError,
  FileSystem.FileSystem | Scope.Scope | GitCore
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* runGit(cwd, ["init", "--initial-branch=main"]);
    yield* runGit(cwd, ["config", "user.email", "test@example.com"]);
    yield* runGit(cwd, ["config", "user.name", "Test User"]);
    yield* fs.writeFileString(path.join(cwd, "README.md"), "hello\n");
    yield* runGit(cwd, ["add", "README.md"]);
    yield* runGit(cwd, ["commit", "-m", "Initial commit"]);
  });
}

function createBareRemote(): Effect.Effect<
  string,
  PlatformError.PlatformError | GitCommandError,
  FileSystem.FileSystem | Scope.Scope | GitCore
> {
  return Effect.gen(function* () {
    const remoteDir = yield* makeTempDir("penkra-git-remote-");
    yield* runGit(remoteDir, ["init", "--bare"]);
    return remoteDir;
  });
}

function resolvePullRequest(manager: GitManagerShape, input: { cwd: string; reference: string }) {
  return manager.resolvePullRequest(input);
}

function preparePullRequestThread(
  manager: GitManagerShape,
  input: { cwd: string; reference: string; mode: "local" | "worktree" },
) {
  return manager.preparePullRequestThread(input);
}

function switchThreadEnvironment(
  manager: GitManagerShape,
  input: {
    cwd: string;
    targetMode: "local" | "worktree";
    currentBranch: string | null;
    worktreePath: string | null;
    associatedWorktreePath: string | null;
    associatedWorktreeBranch: string | null;
    associatedWorktreeRef: string | null;
    preferredLocalBranch: string | null;
    preferredWorktreeBaseBranch: string | null;
    preferredNewWorktreeName: string | null;
  },
) {
  return manager.switchThreadEnvironment(input);
}

function makeManager(input?: { ghScenario?: FakeGhScenario }) {
  const { service: gitHubCli, ghCalls } = createGitHubCliWithFakeGh(input?.ghScenario);
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "penkra-git-manager-test-",
  });

  const gitCoreLayer = GitCoreLive.pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(ServerConfigLayer),
  );

  const managerLayer = Layer.mergeAll(Layer.succeed(GitHubCli, gitHubCli), gitCoreLayer).pipe(
    Layer.provideMerge(NodeServices.layer),
  );

  return makeGitManager.pipe(
    Effect.provide(managerLayer),
    Effect.map((manager) => ({ manager, ghCalls })),
  );
}

const GitManagerTestLayer = GitCoreLive.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "penkra-git-manager-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(GitManagerTestLayer)("GitManager", (it) => {
  it.effect("status includes PR metadata when branch already has an open PR", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("penkra-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-open-pr"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/status-open-pr"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            JSON.stringify([
              {
                number: 13,
                title: "Existing PR",
                url: "https://github.com/example-org/sample-repo/pull/13",
                baseRefName: "main",
                headRefName: "feature/status-open-pr",
                isDraft: true,
                mergeable: "CONFLICTING",
                additions: 38,
                deletions: 36,
                changedFiles: 3,
              },
            ]),
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.branch).toBe("feature/status-open-pr");
      expect(status.pr).toEqual({
        number: 13,
        title: "Existing PR",
        url: "https://github.com/example-org/sample-repo/pull/13",
        baseBranch: "main",
        headBranch: "feature/status-open-pr",
        state: "open",
        isDraft: true,
        mergeability: "conflicting",
        additions: 38,
        deletions: 36,
        changedFiles: 3,
      });
    }),
  );

  it.effect(
    "status detects cross-repo PRs from the upstream remote URL owner",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("penkra-git-manager-");
        yield* initRepo(repoDir);
        const forkDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
        yield* runGit(repoDir, ["checkout", "-b", "statemachine"]);
        fs.writeFileSync(path.join(repoDir, "fork-pr.txt"), "fork pr\n");
        yield* runGit(repoDir, ["add", "fork-pr.txt"]);
        yield* runGit(repoDir, ["commit", "-m", "Fork PR branch"]);
        yield* runGit(repoDir, ["push", "-u", "fork-seed", "statemachine"]);
        yield* runGit(repoDir, ["checkout", "-b", "penkra/pr-488/statemachine"]);
        yield* runGit(repoDir, ["branch", "--set-upstream-to", "fork-seed/statemachine"]);
        yield* runGit(repoDir, [
          "config",
          "remote.fork-seed.url",
          "git@github.com:jasonLaster/sample-repo.git",
        ]);

        const { manager, ghCalls } = yield* makeManager({
          ghScenario: {
            prListSequence: [
              JSON.stringify([]),
              JSON.stringify([]),
              JSON.stringify([
                {
                  number: 488,
                  title: "Rebase this PR on latest main",
                  url: "https://github.com/example-org/sample-repo/pull/488",
                  baseRefName: "main",
                  headRefName: "statemachine",
                  state: "OPEN",
                  updatedAt: "2026-03-10T07:00:00Z",
                },
              ]),
            ],
          },
        });

        const status = yield* manager.status({ cwd: repoDir });
        expect(status.branch).toBe("penkra/pr-488/statemachine");
        expect(status.pr).toEqual({
          number: 488,
          title: "Rebase this PR on latest main",
          url: "https://github.com/example-org/sample-repo/pull/488",
          baseBranch: "main",
          headBranch: "statemachine",
          state: "open",
          isDraft: false,
          mergeability: "unknown",
          additions: null,
          deletions: null,
          changedFiles: null,
        });
        expect(ghCalls).toContain(
          "pr list --head jasonLaster:statemachine --state all --limit 20 --json number,title,url,baseRefName,headRefName,state,mergedAt,isDraft,mergeable,additions,deletions,changedFiles,isCrossRepository,headRepository,headRepositoryOwner,updatedAt",
        );
      }),
    30_000,
  );

  it.effect("status returns merged PR state when latest PR was merged", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("penkra-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-merged-pr"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            JSON.stringify([
              {
                number: 22,
                title: "Merged PR",
                url: "https://github.com/example-org/sample-repo/pull/22",
                baseRefName: "main",
                headRefName: "feature/status-merged-pr",
                state: "MERGED",
                mergedAt: "2026-01-30T10:00:00Z",
                updatedAt: "2026-01-30T10:00:00Z",
              },
            ]),
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.branch).toBe("feature/status-merged-pr");
      expect(status.pr).toEqual({
        number: 22,
        title: "Merged PR",
        url: "https://github.com/example-org/sample-repo/pull/22",
        baseBranch: "main",
        headBranch: "feature/status-merged-pr",
        state: "merged",
        isDraft: false,
        mergeability: "unknown",
        additions: null,
        deletions: null,
        changedFiles: null,
      });
    }),
  );

  it.effect("status prefers open PR when merged PR has newer updatedAt", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("penkra-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-open-over-merged"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            JSON.stringify([
              {
                number: 45,
                title: "Merged PR",
                url: "https://github.com/example-org/sample-repo/pull/45",
                baseRefName: "main",
                headRefName: "feature/status-open-over-merged",
                state: "MERGED",
                mergedAt: "2026-01-31T10:00:00Z",
                updatedAt: "2026-02-01T10:00:00Z",
              },
              {
                number: 46,
                title: "Open PR",
                url: "https://github.com/example-org/sample-repo/pull/46",
                baseRefName: "main",
                headRefName: "feature/status-open-over-merged",
                state: "OPEN",
                updatedAt: "2026-01-30T10:00:00Z",
              },
            ]),
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.branch).toBe("feature/status-open-over-merged");
      expect(status.pr).toEqual({
        number: 46,
        title: "Open PR",
        url: "https://github.com/example-org/sample-repo/pull/46",
        baseBranch: "main",
        headBranch: "feature/status-open-over-merged",
        state: "open",
        isDraft: false,
        mergeability: "unknown",
        additions: null,
        deletions: null,
        changedFiles: null,
      });
    }),
  );

  it.effect("status is resilient to gh lookup failures and returns pr null", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("penkra-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-no-gh"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/status-no-gh"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          failWith: new GitHubCliError({
            operation: "execute",
            detail: "GitHub CLI (`gh`) is required but not available on PATH.",
          }),
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.branch).toBe("feature/status-no-gh");
      expect(status.pr).toBeNull();
    }),
  );

  it.effect("resolves pull requests from #number references", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("penkra-git-manager-");
      yield* initRepo(repoDir);

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 42,
            title: "Resolve PR",
            url: "https://github.com/example-org/sample-repo/pull/42",
            baseRefName: "main",
            headRefName: "feature/resolve-pr",
            state: "open",
          },
        },
      });

      const result = yield* resolvePullRequest(manager, {
        cwd: repoDir,
        reference: "#42",
      });

      expect(result.pullRequest).toEqual({
        number: 42,
        title: "Resolve PR",
        url: "https://github.com/example-org/sample-repo/pull/42",
        baseBranch: "main",
        headBranch: "feature/resolve-pr",
        state: "open",
        isDraft: false,
        mergeability: "unknown",
        additions: null,
        deletions: null,
        changedFiles: null,
      });
      expect(ghCalls.some((call) => call.startsWith("pr view 42 "))).toBe(true);
    }),
  );

  it.effect("loads PR snapshots with checks and review comments", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("penkra-git-manager-");
      yield* initRepo(repoDir);

      const checks: GitPullRequestCheck[] = [
        { name: "Format, Lint, Typecheck", status: "pending", url: null },
        { name: "Release Smoke", status: "success", url: "https://ci.example/2" },
      ];
      const comments: GitPullRequestComment[] = [
        {
          id: "11",
          author: "codex-bot",
          body: "Avoid returning shims directly",
          path: "CursorAcpCommand.ts",
          url: "https://github.com/example-org/sample-repo/pull/42#discussion_r11",
          createdAt: "2026-07-01T10:00:00Z",
        },
      ];

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 42,
            title: "Snapshot PR",
            url: "https://github.enterprise.test/example-org/sample-repo/pull/42",
            baseRefName: "main",
            headRefName: "feature/snapshot-pr",
            state: "open",
          },
          pullRequestChecks: checks,
          pullRequestReviewComments: comments,
          pullRequestReviewCommentsTruncated: true,
        },
      });

      const result = yield* manager.pullRequestSnapshot({
        cwd: repoDir,
        reference: "#42",
      });

      expect(result.pullRequest.number).toBe(42);
      expect(result.checks).toEqual(checks);
      expect(result.comments).toEqual(comments);
      expect(result.commentsTruncated).toBe(true);
      expect(result.commentsError).toBeNull();
      expect(ghCalls).toContain(
        `pr view 42 --json ${PULL_REQUEST_SUMMARY_JSON_FIELDS},statusCheckRollup`,
      );
      // Owner/repo come from the PR URL, not the local checkout's remotes.
      expect(ghCalls).toContain(
        "api graphql reviewThreads github.enterprise.test/example-org/sample-repo#42",
      );
    }),
  );

  it.effect("keeps checks when PR review comments cannot be loaded", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("penkra-git-manager-");
      yield* initRepo(repoDir);

      const checks: GitPullRequestCheck[] = [
        { name: "Format, Lint, Typecheck", status: "success", url: "https://ci.example/1" },
      ];
      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 43,
            title: "Checks still visible",
            url: "https://github.com/example-org/sample-repo/pull/43",
            baseRefName: "main",
            headRefName: "feature/checks-still-visible",
            state: "open",
          },
          pullRequestChecks: checks,
          reviewCommentsError: new GitHubCliError({
            operation: "getPullRequestReviewComments",
            detail: "GraphQL rate limit exceeded.",
          }),
        },
      });

      const result = yield* manager.pullRequestSnapshot({
        cwd: repoDir,
        reference: "#43",
      });

      expect(result.checks).toEqual(checks);
      expect(result.comments).toEqual([]);
      expect(result.commentsTruncated).toBe(false);
      expect(result.commentsError).toContain("GraphQL rate limit exceeded");
    }),
  );

  it.effect("fails PR snapshots when the repository cannot be derived from the URL", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("penkra-git-manager-");
      yield* initRepo(repoDir);

      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 7,
            title: "Odd URL",
            url: "https://example.test/not-a-pr",
            baseRefName: "main",
            headRefName: "feature/odd-url",
            state: "open",
          },
        },
      });

      const errorMessage = yield* manager
        .pullRequestSnapshot({ cwd: repoDir, reference: "#7" })
        .pipe(
          Effect.flip,
          Effect.map((error) => error.message),
        );
      expect(errorMessage).toContain("Could not determine the repository");
    }),
  );

  it.effect("prepares pull request threads in local mode by checking out the PR branch", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("penkra-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-local"]);
      fs.writeFileSync(path.join(repoDir, "local.txt"), "local\n");
      yield* runGit(repoDir, ["add", "local.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Local PR branch"]);

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 64,
            title: "Local PR",
            url: "https://github.com/example-org/sample-repo/pull/64",
            baseRefName: "main",
            headRefName: "feature/pr-local",
            state: "open",
          },
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "#64",
        mode: "local",
      });

      expect(result.branch).toBe("feature/pr-local");
      expect(result.worktreePath).toBeNull();
      const branch = (yield* runGit(repoDir, ["branch", "--show-current"])).stdout.trim();
      expect(branch).toBe("feature/pr-local");
      expect(ghCalls).toContain("pr checkout 64 --force");
    }),
  );

  it.effect("prepares pull request threads in worktree mode on the PR head branch", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("penkra-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-worktree"]);
      fs.writeFileSync(path.join(repoDir, "worktree.txt"), "worktree\n");
      yield* runGit(repoDir, ["add", "worktree.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "PR worktree branch"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-worktree"]);
      yield* runGit(repoDir, ["push", "origin", "HEAD:refs/pull/77/head"]);
      yield* runGit(repoDir, ["checkout", "main"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 77,
            title: "Worktree PR",
            url: "https://github.com/example-org/sample-repo/pull/77",
            baseRefName: "main",
            headRefName: "feature/pr-worktree",
            state: "open",
          },
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "77",
        mode: "worktree",
      });

      expect(result.branch).toBe("feature/pr-worktree");
      expect(result.worktreePath).not.toBeNull();
      expect(fs.existsSync(result.worktreePath as string)).toBe(true);
      const worktreeBranch = (yield* runGit(result.worktreePath as string, [
        "branch",
        "--show-current",
      ])).stdout.trim();
      expect(worktreeBranch).toBe("feature/pr-worktree");
    }),
  );

  it.effect("preserves fork upstream tracking when preparing a worktree PR thread", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("penkra-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-fork"]);
      fs.writeFileSync(path.join(repoDir, "fork.txt"), "fork\n");
      yield* runGit(repoDir, ["add", "fork.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Fork PR branch"]);
      yield* runGit(repoDir, ["push", "-u", "fork-seed", "feature/pr-fork"]);
      yield* runGit(repoDir, ["checkout", "main"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 81,
            title: "Fork PR",
            url: "https://github.com/example-org/sample-repo/pull/81",
            baseRefName: "main",
            headRefName: "feature/pr-fork",
            state: "open",
            isCrossRepository: true,
            headRepositoryNameWithOwner: "octocat/sample-repo",
            headRepositoryOwnerLogin: "octocat",
          },
          repositoryCloneUrls: {
            "octocat/sample-repo": {
              url: forkDir,
              sshUrl: forkDir,
            },
          },
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "81",
        mode: "worktree",
      });

      expect(result.worktreePath).not.toBeNull();
      const upstreamRef = (yield* runGit(result.worktreePath as string, [
        "rev-parse",
        "--abbrev-ref",
        "@{upstream}",
      ])).stdout.trim();
      expect(upstreamRef).toBe("fork-seed/feature/pr-fork");
      expect(upstreamRef.startsWith("origin/")).toBe(false);
      expect(
        (yield* runGit(result.worktreePath as string, [
          "config",
          "--get",
          "remote.fork-seed.url",
        ])).stdout.trim(),
      ).toBe(forkDir);
    }),
  );

  it.effect("preserves fork upstream tracking when preparing a local PR thread", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("penkra-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-local-fork"]);
      fs.writeFileSync(path.join(repoDir, "local-fork.txt"), "local fork\n");
      yield* runGit(repoDir, ["add", "local-fork.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Local fork PR branch"]);
      yield* runGit(repoDir, ["push", "-u", "fork-seed", "feature/pr-local-fork"]);
      yield* runGit(repoDir, ["checkout", "main"]);
      yield* runGit(repoDir, ["branch", "-D", "feature/pr-local-fork"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 82,
            title: "Local Fork PR",
            url: "https://github.com/example-org/sample-repo/pull/82",
            baseRefName: "main",
            headRefName: "feature/pr-local-fork",
            state: "open",
            isCrossRepository: true,
            headRepositoryNameWithOwner: "octocat/sample-repo",
            headRepositoryOwnerLogin: "octocat",
          },
          repositoryCloneUrls: {
            "octocat/sample-repo": {
              url: forkDir,
              sshUrl: forkDir,
            },
          },
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "82",
        mode: "local",
      });

      expect(result.worktreePath).toBeNull();
      expect(result.branch).toBe("feature/pr-local-fork");
      expect(
        (yield* runGit(repoDir, ["rev-parse", "--abbrev-ref", "@{upstream}"])).stdout.trim(),
      ).toBe("fork-seed/feature/pr-local-fork");
    }),
  );

  it.effect("derives fork repository identity from PR URL when GitHub omits nameWithOwner", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("penkra-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "add", "binbandit-seed", forkDir]);
      yield* runGit(repoDir, ["checkout", "-b", "fix/git-action-default-without-origin"]);
      fs.writeFileSync(path.join(repoDir, "derived-fork.txt"), "derived fork\n");
      yield* runGit(repoDir, ["add", "derived-fork.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Derived fork PR branch"]);
      yield* runGit(repoDir, [
        "push",
        "-u",
        "binbandit-seed",
        "fix/git-action-default-without-origin",
      ]);
      yield* runGit(repoDir, ["checkout", "main"]);
      yield* runGit(repoDir, ["branch", "-D", "fix/git-action-default-without-origin"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 642,
            title: "fix: use commit as the default git action without origin",
            url: "https://github.com/example-org/penkra/pull/642",
            baseRefName: "main",
            headRefName: "fix/git-action-default-without-origin",
            state: "open",
            isCrossRepository: true,
            headRepositoryOwnerLogin: "binbandit",
          },
          repositoryCloneUrls: {
            "binbandit/penkra": {
              url: forkDir,
              sshUrl: forkDir,
            },
          },
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "642",
        mode: "local",
      });

      expect(result.branch).toBe("fix/git-action-default-without-origin");
      expect(result.worktreePath).toBeNull();
      expect(
        (yield* runGit(repoDir, ["rev-parse", "--abbrev-ref", "@{upstream}"])).stdout.trim(),
      ).toBe("binbandit-seed/fix/git-action-default-without-origin");
    }),
  );

  it.effect("reuses an existing dedicated worktree for the PR head branch", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("penkra-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-existing-worktree"]);
      fs.writeFileSync(path.join(repoDir, "existing.txt"), "existing\n");
      yield* runGit(repoDir, ["add", "existing.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Existing worktree branch"]);
      yield* runGit(repoDir, ["checkout", "main"]);
      const worktreePath = path.join(repoDir, "..", `pr-existing-${Date.now()}`);
      yield* runGit(repoDir, ["worktree", "add", worktreePath, "feature/pr-existing-worktree"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 78,
            title: "Existing worktree PR",
            url: "https://github.com/example-org/sample-repo/pull/78",
            baseRefName: "main",
            headRefName: "feature/pr-existing-worktree",
            state: "open",
          },
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "78",
        mode: "worktree",
      });

      expect(result.worktreePath && fs.realpathSync.native(result.worktreePath)).toBe(
        fs.realpathSync.native(worktreePath),
      );
      expect(result.branch).toBe("feature/pr-existing-worktree");
    }),
  );

  it.effect(
    "does not block fork PR worktree prep when the fork head branch collides with root main",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("penkra-git-manager-");
        yield* initRepo(repoDir);
        const originDir = yield* createBareRemote();
        const forkDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
        yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
        yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
        yield* runGit(repoDir, ["checkout", "-b", "fork-main-source"]);
        fs.writeFileSync(path.join(repoDir, "fork-main.txt"), "fork main\n");
        yield* runGit(repoDir, ["add", "fork-main.txt"]);
        yield* runGit(repoDir, ["commit", "-m", "Fork main branch"]);
        yield* runGit(repoDir, ["push", "-u", "fork-seed", "fork-main-source:main"]);
        yield* runGit(repoDir, ["checkout", "main"]);
        const mainBefore = (yield* runGit(repoDir, ["rev-parse", "main"])).stdout.trim();

        const { manager } = yield* makeManager({
          ghScenario: {
            pullRequest: {
              number: 91,
              title: "Fork main PR",
              url: "https://github.com/example-org/sample-repo/pull/91",
              baseRefName: "main",
              headRefName: "main",
              state: "open",
              isCrossRepository: true,
              headRepositoryNameWithOwner: "octocat/sample-repo",
              headRepositoryOwnerLogin: "octocat",
            },
            repositoryCloneUrls: {
              "octocat/sample-repo": {
                url: forkDir,
                sshUrl: forkDir,
              },
            },
          },
        });

        const result = yield* preparePullRequestThread(manager, {
          cwd: repoDir,
          reference: "91",
          mode: "worktree",
        });

        expect(result.branch).toBe("penkra/pr-91/main");
        expect(result.worktreePath).not.toBeNull();
        expect((yield* runGit(repoDir, ["branch", "--show-current"])).stdout.trim()).toBe("main");
        expect((yield* runGit(repoDir, ["rev-parse", "main"])).stdout.trim()).toBe(mainBefore);
        expect(
          (yield* runGit(result.worktreePath as string, [
            "branch",
            "--show-current",
          ])).stdout.trim(),
        ).toBe("penkra/pr-91/main");
      }),
  );

  it.effect(
    "does not overwrite an existing local main branch when preparing a fork PR worktree",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("penkra-git-manager-");
        yield* initRepo(repoDir);
        const originDir = yield* createBareRemote();
        const forkDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
        yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
        yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
        yield* runGit(repoDir, ["checkout", "-b", "fork-main-source"]);
        fs.writeFileSync(path.join(repoDir, "fork-main-second.txt"), "fork main second\n");
        yield* runGit(repoDir, ["add", "fork-main-second.txt"]);
        yield* runGit(repoDir, ["commit", "-m", "Fork main second branch"]);
        yield* runGit(repoDir, ["push", "-u", "fork-seed", "fork-main-source:main"]);
        yield* runGit(repoDir, ["checkout", "main"]);
        const localMainBefore = (yield* runGit(repoDir, ["rev-parse", "main"])).stdout.trim();
        yield* runGit(repoDir, ["checkout", "-b", "feature/root-branch"]);

        const { manager } = yield* makeManager({
          ghScenario: {
            pullRequest: {
              number: 92,
              title: "Fork main overwrite PR",
              url: "https://github.com/example-org/sample-repo/pull/92",
              baseRefName: "main",
              headRefName: "main",
              state: "open",
              isCrossRepository: true,
              headRepositoryNameWithOwner: "octocat/sample-repo",
              headRepositoryOwnerLogin: "octocat",
            },
            repositoryCloneUrls: {
              "octocat/sample-repo": {
                url: forkDir,
                sshUrl: forkDir,
              },
            },
          },
        });

        const result = yield* preparePullRequestThread(manager, {
          cwd: repoDir,
          reference: "92",
          mode: "worktree",
        });

        expect(result.branch).toBe("penkra/pr-92/main");
        expect((yield* runGit(repoDir, ["rev-parse", "main"])).stdout.trim()).toBe(localMainBefore);
        expect(
          (yield* runGit(result.worktreePath as string, [
            "rev-parse",
            "--abbrev-ref",
            "@{upstream}",
          ])).stdout.trim(),
        ).toBe("fork-seed/main");
      }),
  );

  it.effect("reuses an existing PR worktree and restores fork upstream tracking", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("penkra-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-reused-fork"]);
      fs.writeFileSync(path.join(repoDir, "reused-fork.txt"), "reused fork\n");
      yield* runGit(repoDir, ["add", "reused-fork.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Reused fork PR branch"]);
      yield* runGit(repoDir, ["push", "-u", "fork-seed", "feature/pr-reused-fork"]);
      yield* runGit(repoDir, ["checkout", "main"]);
      const worktreePath = path.join(repoDir, "..", `pr-reused-fork-${Date.now()}`);
      yield* runGit(repoDir, ["worktree", "add", worktreePath, "feature/pr-reused-fork"]);
      yield* runGit(worktreePath, ["branch", "--unset-upstream"], true);

      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 83,
            title: "Reused Fork PR",
            url: "https://github.com/example-org/sample-repo/pull/83",
            baseRefName: "main",
            headRefName: "feature/pr-reused-fork",
            state: "open",
            isCrossRepository: true,
            headRepositoryNameWithOwner: "octocat/sample-repo",
            headRepositoryOwnerLogin: "octocat",
          },
          repositoryCloneUrls: {
            "octocat/sample-repo": {
              url: forkDir,
              sshUrl: forkDir,
            },
          },
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "83",
        mode: "worktree",
      });

      expect(result.worktreePath && fs.realpathSync.native(result.worktreePath)).toBe(
        fs.realpathSync.native(worktreePath),
      );
      expect(
        (yield* runGit(worktreePath, ["rev-parse", "--abbrev-ref", "@{upstream}"])).stdout.trim(),
      ).toBe("fork-seed/feature/pr-reused-fork");
    }),
  );

  it.effect("rejects worktree prep when the PR head branch is checked out in the main repo", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("penkra-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-root-only"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 79,
            title: "Root-only PR",
            url: "https://github.com/example-org/sample-repo/pull/79",
            baseRefName: "main",
            headRefName: "feature/pr-root-only",
            state: "open",
          },
        },
      });

      const errorMessage = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "79",
        mode: "worktree",
      }).pipe(
        Effect.flip,
        Effect.map((error) => error.message),
      );

      expect(errorMessage).toContain("already checked out in the main repo");
    }),
  );

  it.effect(
    "creates a new environment switch worktree on a named branch instead of detached HEAD",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("penkra-git-manager-");
        yield* initRepo(repoDir);

        const { manager } = yield* makeManager();
        const result = yield* switchThreadEnvironment(manager, {
          cwd: repoDir,
          targetMode: "worktree",
          currentBranch: "main",
          worktreePath: null,
          associatedWorktreePath: null,
          associatedWorktreeBranch: null,
          associatedWorktreeRef: null,
          preferredLocalBranch: "main",
          preferredWorktreeBaseBranch: "main",
          preferredNewWorktreeName: "worktree/demo-environment switch",
        });

        expect(result.targetMode).toBe("worktree");
        expect(result.branch).toBe("penkra/worktree/demo-environment-switch");
        expect(result.associatedWorktreeBranch).toBe("penkra/worktree/demo-environment-switch");

        const worktreeBranch = (yield* runGit(result.worktreePath as string, [
          "rev-parse",
          "--abbrev-ref",
          "HEAD",
        ])).stdout.trim();
        expect(worktreeBranch).toBe("penkra/worktree/demo-environment-switch");

        const localBranch = (yield* runGit(repoDir, [
          "rev-parse",
          "--abbrev-ref",
          "HEAD",
        ])).stdout.trim();
        expect(localBranch).toBe("main");
      }),
  );

  it.effect(
    "carries uncommitted local changes into a new environment switch worktree without leaking the stash",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("penkra-git-manager-");
        yield* initRepo(repoDir);

        // Create uncommitted working-tree changes so switchThreadEnvironment takes the stash path.
        // This is the path that previously failed with:
        //   "<sha>" is not a stash reference
        // because git rev-parse refs/stash returns a commit SHA, but `git stash pop`
        // requires a `stash@{N}` reference.
        const workingFile = path.join(repoDir, "uncommitted.txt");
        fs.writeFileSync(workingFile, "draft change\n");

        const { manager } = yield* makeManager();
        const result = yield* switchThreadEnvironment(manager, {
          cwd: repoDir,
          targetMode: "worktree",
          currentBranch: "main",
          worktreePath: null,
          associatedWorktreePath: null,
          associatedWorktreeBranch: null,
          associatedWorktreeRef: null,
          preferredLocalBranch: "main",
          preferredWorktreeBaseBranch: "main",
          preferredNewWorktreeName: "worktree/stash-environment switch",
        });

        expect(result.targetMode).toBe("worktree");
        expect(result.changesTransferred).toBe(true);
        expect(result.conflictsDetected).toBe(false);

        // The uncommitted change should now live inside the new worktree.
        const transferredPath = path.join(result.worktreePath as string, "uncommitted.txt");
        expect(fs.existsSync(transferredPath)).toBe(true);
        expect(fs.readFileSync(transferredPath, "utf8")).toBe("draft change\n");

        // The original local checkout should be clean again.
        expect(fs.existsSync(workingFile)).toBe(false);

        // The stash entry must have been dropped after a successful apply — otherwise
        // we would leak `stash@{0}` on every environment switch that carries uncommitted work.
        const stashList = (yield* runGit(repoDir, ["stash", "list"])).stdout.trim();
        expect(stashList).toBe("");
      }),
  );
});
