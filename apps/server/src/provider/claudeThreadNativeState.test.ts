import { strict as assert } from "node:assert";
import { access, mkdtemp, mkdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as Path from "node:path";
import { afterEach, it } from "vitest";

import {
  claudeThreadHasConversation,
  claudeAccountsMatch,
  claudeThreadProjectName,
  claudeThreadStateRoot,
  claudeThreadTranscriptPath,
  prepareClaudeThreadProject,
  prepareClaudeThreadSidecars,
} from "./claudeThreadNativeState.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("normalizes Claude subscription emails and rejects an account change", () => {
  assert.equal(
    claudeAccountsMatch(
      { authenticationMethodId: "claude-account", providerIdentityId: " Alice@Example.com " },
      { authenticationMethodId: "claude-account", providerIdentityId: "alice@example.com" },
    ),
    true,
  );
  assert.equal(
    claudeAccountsMatch(
      { authenticationMethodId: "claude-account", providerIdentityId: "alice@example.com" },
      { authenticationMethodId: "claude-account", providerIdentityId: "bob@example.com" },
    ),
    false,
  );
});

it("refuses to expose a Thread's Claude project to a different subscription account", async () => {
  const root = await mkdtemp(Path.join(tmpdir(), "penkra-claude-account-guard-"));
  roots.push(root);
  const stateDir = Path.join(root, "state");
  const threadId = "owned-thread";
  const configA = Path.join(root, "profile-a", "claude-config");
  const configB = Path.join(root, "profile-b", "claude-config");
  await prepareClaudeThreadProject({
    stateDir,
    threadId,
    configDir: configA,
    account: {
      authenticationMethodId: "claude-account",
      providerIdentityId: "alice@example.com",
    },
  });
  await assert.rejects(
    prepareClaudeThreadProject({
      stateDir,
      threadId,
      configDir: configB,
      account: {
        authenticationMethodId: "claude-account",
        providerIdentityId: "bob@example.com",
      },
    }),
    /same account/,
  );
  await assert.rejects(access(Path.join(configB, "projects", claudeThreadProjectName(threadId))));
});

it("keeps one Thread's transcript through a Connection replacement and repairs stale links", async () => {
  const root = await mkdtemp(Path.join(tmpdir(), "penkra-claude-thread-owned-"));
  roots.push(root);
  const stateDir = Path.join(root, "state");
  const threadId = "thread-a";
  const configA = Path.join(root, "profile-a", "claude-config");
  const configB = Path.join(root, "profile-b", "claude-config");
  const projectName = claudeThreadProjectName(threadId);
  const target = Path.join(claudeThreadStateRoot(stateDir, threadId), "project");
  await prepareClaudeThreadProject({ stateDir, threadId, configDir: configA });
  const transcript = claudeThreadTranscriptPath(stateDir, threadId, "session-a");
  await writeFile(transcript, '{"type":"user","message":{"role":"user","content":"hello"}}\n');
  assert.equal(await claudeThreadHasConversation(stateDir, threadId, "session-a"), true);

  const linkB = Path.join(configB, "projects", projectName);
  await mkdir(Path.dirname(linkB), { recursive: true });
  await symlink(Path.join(root, "stale-target"), linkB);
  await Promise.all([
    prepareClaudeThreadProject({ stateDir, threadId, configDir: configB }),
    prepareClaudeThreadProject({ stateDir, threadId, configDir: configB }),
  ]);
  assert.equal(await readlink(linkB), target);
  await prepareClaudeThreadSidecars({ configDir: configB, projectName, sessionId: "session-a" });
  assert.equal(
    await readlink(Path.join(configB, "tasks", "session-a")),
    Path.join(claudeThreadStateRoot(stateDir, threadId), "tasks", "session-a"),
  );
  await rm(Path.join(root, "profile-a"), { recursive: true });
  assert.equal(await claudeThreadHasConversation(stateDir, threadId, "session-a"), true);
  assert.equal(await readlink(linkB), target);
  // Switch to B, disconnect B, then reconnect the same login in a new profile.
  await rm(Path.join(root, "profile-b"), { recursive: true });
  const configC = Path.join(root, "profile-c", "claude-config");
  await prepareClaudeThreadProject({ stateDir, threadId, configDir: configC });
  assert.equal(await readlink(Path.join(configC, "projects", projectName)), target);
  assert.equal(await claudeThreadHasConversation(stateDir, threadId, "session-a"), true);
});

it("isolates concurrent Threads under one Claude config", async () => {
  const root = await mkdtemp(Path.join(tmpdir(), "penkra-claude-thread-concurrent-"));
  roots.push(root);
  const stateDir = Path.join(root, "state");
  const configDir = Path.join(root, "profile", "claude-config");
  await Promise.all(
    ["thread-one", "thread-two"].map((threadId) =>
      prepareClaudeThreadProject({ stateDir, threadId, configDir }),
    ),
  );
  for (const threadId of ["thread-one", "thread-two"]) {
    assert.equal(
      await readlink(Path.join(configDir, "projects", claudeThreadProjectName(threadId))),
      Path.join(claudeThreadStateRoot(stateDir, threadId), "project"),
    );
  }
  assert.notEqual(claudeThreadProjectName("thread-one"), claudeThreadProjectName("thread-two"));
  assert.equal(await claudeThreadHasConversation(stateDir, "thread-one", "missing"), false);
});

it("treats a metadata-only Claude JSONL as unavailable for exact resume", async () => {
  const root = await mkdtemp(Path.join(tmpdir(), "penkra-claude-thread-metadata-"));
  roots.push(root);
  const stateDir = Path.join(root, "state");
  const threadId = "metadata-thread";
  await prepareClaudeThreadProject({
    stateDir,
    threadId,
    configDir: Path.join(root, "profile", "claude-config"),
  });
  await writeFile(
    claudeThreadTranscriptPath(stateDir, threadId, "metadata-session"),
    '{"type":"last-prompt","prompt":"hello"}\n',
  );
  assert.equal(await claudeThreadHasConversation(stateDir, threadId, "metadata-session"), false);
});
