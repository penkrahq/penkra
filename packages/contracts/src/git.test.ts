import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  GitCreateWorktreeInput,
  GitSwitchThreadEnvironmentInput,
  GitPreparePullRequestThreadInput,
  GitResolvePullRequestResult,
} from "./git";

const decodeCreateWorktreeInput = Schema.decodeUnknownSync(GitCreateWorktreeInput);
const decodeThreadEnvironmentSwitchInput = Schema.decodeUnknownSync(
  GitSwitchThreadEnvironmentInput,
);
const decodePreparePullRequestThreadInput = Schema.decodeUnknownSync(
  GitPreparePullRequestThreadInput,
);
const decodeResolvePullRequestResult = Schema.decodeUnknownSync(GitResolvePullRequestResult);

describe("GitCreateWorktreeInput", () => {
  it("accepts omitted newBranch for existing-branch worktrees", () => {
    const parsed = decodeCreateWorktreeInput({
      cwd: "/repo",
      branch: "feature/existing",
      path: "/tmp/worktree",
    });

    expect(parsed.newBranch).toBeUndefined();
    expect(parsed.branch).toBe("feature/existing");
  });
});

describe("GitSwitchThreadEnvironmentInput", () => {
  it("carries durable orchestration identity with the Git environment switch", () => {
    const parsed = decodeThreadEnvironmentSwitchInput({
      commandId: "command-environment-switch-1",
      threadId: "thread-environment-switch-1",
      cwd: "/repo",
      targetMode: "worktree",
      currentBranch: "main",
      worktreePath: null,
      associatedWorktreePath: null,
      associatedWorktreeBranch: null,
      associatedWorktreeRef: null,
      preferredLocalBranch: "main",
      preferredWorktreeBaseBranch: "main",
      preferredNewWorktreeName: "worktree/environment-switch",
    });

    expect(parsed.commandId).toBe("command-environment-switch-1");
    expect(parsed.threadId).toBe("thread-environment-switch-1");
  });
});

describe("GitPreparePullRequestThreadInput", () => {
  it("accepts pull request references and mode", () => {
    const parsed = decodePreparePullRequestThreadInput({
      cwd: "/repo",
      reference: "#42",
      mode: "worktree",
    });

    expect(parsed.reference).toBe("#42");
    expect(parsed.mode).toBe("worktree");
  });
});

describe("GitResolvePullRequestResult", () => {
  it("decodes resolved pull request metadata", () => {
    const parsed = decodeResolvePullRequestResult({
      pullRequest: {
        number: 42,
        title: "PR threads",
        url: "https://github.com/example-org/sample-repo/pull/42",
        baseBranch: "main",
        headBranch: "feature/pr-threads",
        state: "open",
        isDraft: true,
        mergeability: "conflicting",
        additions: 38,
        deletions: 36,
        changedFiles: 3,
      },
    });

    expect(parsed.pullRequest.number).toBe(42);
    expect(parsed.pullRequest.headBranch).toBe("feature/pr-threads");
    expect(parsed.pullRequest.isDraft).toBe(true);
    expect(parsed.pullRequest.mergeability).toBe("conflicting");
    expect(parsed.pullRequest.additions).toBe(38);
  });
});
