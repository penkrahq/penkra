import { strict as assert } from "node:assert";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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
  readClaudeThreadAccount,
  stageClaudeThreadAccountTransition,
  discardClaudeThreadAccountTransition,
} from "./claudeThreadNativeState.ts";
import { providerOpaquePathKey } from "./providerNativeStatePaths.ts";

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
  const configA = Path.join(stateDir, "provider-connections", "profile-a", "claude-config");
  const configB = Path.join(stateDir, "provider-connections", "profile-b", "claude-config");
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
    /This thread's Claude conversation belongs to a different Claude account\. Use a Connection signed in to that account, or start a new thread\./,
  );
  await assert.rejects(access(Path.join(configB, "projects", claudeThreadProjectName(threadId))));
});

it("transfers Claude ownership only after the exact explicit switch binding commits", async () => {
  const root = await mkdtemp(Path.join(tmpdir(), "penkra-claude-account-switch-"));
  roots.push(root);
  const stateDir = Path.join(root, "state");
  const threadId = "switch-thread";
  const source = {
    authenticationMethodId: "claude-account",
    providerIdentityId: "alice@example.com",
  };
  const target = {
    authenticationMethodId: "claude-account",
    providerIdentityId: "bob@example.com",
  };
  const configA = Path.join(stateDir, "provider-connections", "profile-a", "claude-config");
  const configB = Path.join(stateDir, "provider-connections", "profile-b", "claude-config");
  await prepareClaudeThreadProject({ stateDir, threadId, configDir: configA, account: source });
  await writeFile(
    claudeThreadTranscriptPath(stateDir, threadId, "exact-session"),
    "exact native history",
  );
  await stageClaudeThreadAccountTransition({
    stateDir,
    threadId,
    transition: {
      commandId: "switch-command",
      connectionId: "connection-b",
      bindingRevision: 8,
      source,
      target,
    },
  });
  const launchTarget = (bindingConnectionId: string, bindingRevision: number) =>
    prepareClaudeThreadProject({
      stateDir,
      threadId,
      configDir: configB,
      account: target,
      connectionId: "connection-b",
      bindingConnectionId,
      bindingRevision,
    });
  await launchTarget("connection-a", 7);
  await assert.rejects(launchTarget("connection-b", 7));
  assert.deepEqual(await readClaudeThreadAccount(stateDir, threadId), source);
  assert.notStrictEqual(
    await readlink(Path.join(configA, "projects", claudeThreadProjectName(threadId))),
    await readlink(Path.join(configB, "projects", claudeThreadProjectName(threadId))),
  );
  const targetProject = await readlink(
    Path.join(configB, "projects", claudeThreadProjectName(threadId)),
  );
  assert.strictEqual(
    await readFile(Path.join(targetProject, "exact-session.jsonl"), "utf8"),
    "exact native history",
  );
  await launchTarget("connection-b", 8);
  assert.deepEqual(await readClaudeThreadAccount(stateDir, threadId), {
    ...target,
    projectRevision: 8,
  });
  await assert.rejects(access(Path.join(configA, "projects", claudeThreadProjectName(threadId))));
  await writeFile(Path.join(targetProject, "new-session.jsonl"), "new account output");
  await assert.rejects(access(claudeThreadTranscriptPath(stateDir, threadId, "new-session")));
  await rm(Path.dirname(targetProject), { recursive: true, force: true });
  await prepareClaudeThreadProject({
    stateDir,
    threadId,
    configDir: configB,
    account: target,
  });
  assert.strictEqual(
    await readlink(Path.join(configB, "projects", claudeThreadProjectName(threadId))),
    targetProject,
  );
  await assert.rejects(access(Path.join(targetProject, "exact-session.jsonl")));
  await assert.rejects(
    prepareClaudeThreadProject({ stateDir, threadId, configDir: configA, account: source }),
  );
  await discardClaudeThreadAccountTransition({ stateDir, threadId, commandId: "switch-command" });
});

it("restores a probed target copy from source before the switch commits", async () => {
  const root = await mkdtemp(Path.join(tmpdir(), "penkra-claude-probe-reset-"));
  roots.push(root);
  const stateDir = Path.join(root, "state");
  const threadId = "probe-reset-thread";
  const source = {
    authenticationMethodId: "claude-account",
    providerIdentityId: "alice@example.com",
  };
  const target = {
    authenticationMethodId: "claude-account",
    providerIdentityId: "bob@example.com",
  };
  const configA = Path.join(stateDir, "provider-connections", "profile-a", "claude-config");
  const configB = Path.join(stateDir, "provider-connections", "profile-b", "claude-config");
  await prepareClaudeThreadProject({ stateDir, threadId, configDir: configA, account: source });
  await writeFile(claudeThreadTranscriptPath(stateDir, threadId, "session"), "source history");
  const transition = {
    commandId: "probe-reset-command",
    connectionId: "connection-b",
    bindingRevision: 2,
    source,
    target,
  };
  await stageClaudeThreadAccountTransition({ stateDir, threadId, transition });
  await prepareClaudeThreadProject({
    stateDir,
    threadId,
    configDir: configB,
    account: target,
    connectionId: "connection-b",
    bindingConnectionId: "connection-a",
    bindingRevision: 1,
  });
  const link = Path.join(configB, "projects", claudeThreadProjectName(threadId));
  const targetProject = await readlink(link);
  await writeFile(Path.join(targetProject, "session.jsonl"), "source history\nprobe turn");
  await writeFile(Path.join(targetProject, "probe-only.jsonl"), "probe artifact");
  await stageClaudeThreadAccountTransition({ stateDir, threadId, transition });
  await assert.rejects(access(link));
  assert.equal(await readFile(Path.join(targetProject, "session.jsonl"), "utf8"), "source history");
  await assert.rejects(access(Path.join(targetProject, "probe-only.jsonl")));
});

it("discards a failed account switch without changing the owner", async () => {
  const root = await mkdtemp(Path.join(tmpdir(), "penkra-claude-account-switch-failed-"));
  roots.push(root);
  const stateDir = Path.join(root, "state");
  const threadId = "failed-switch-thread";
  const source = {
    authenticationMethodId: "claude-account",
    providerIdentityId: "alice@example.com",
  };
  const target = {
    authenticationMethodId: "claude-account",
    providerIdentityId: "bob@example.com",
  };
  const targetConfig = Path.join(stateDir, "provider-connections", "profile-b", "claude-config");
  await prepareClaudeThreadProject({
    stateDir,
    threadId,
    configDir: Path.join(root, "profile-a"),
    account: source,
  });
  await stageClaudeThreadAccountTransition({
    stateDir,
    threadId,
    transition: {
      commandId: "failed-command",
      connectionId: "connection-b",
      bindingRevision: 8,
      source,
      target,
    },
  });
  await prepareClaudeThreadProject({
    stateDir,
    threadId,
    configDir: targetConfig,
    account: target,
    connectionId: "connection-b",
    bindingConnectionId: "connection-a",
    bindingRevision: 7,
  });
  await discardClaudeThreadAccountTransition({ stateDir, threadId, commandId: "failed-command" });
  await assert.rejects(
    access(Path.join(targetConfig, "projects", claudeThreadProjectName(threadId))),
  );
  await assert.rejects(
    prepareClaudeThreadProject({
      stateDir,
      threadId,
      configDir: Path.join(root, "profile-b"),
      account: target,
      connectionId: "connection-b",
      bindingConnectionId: "connection-b",
      bindingRevision: 8,
    }),
  );
  assert.deepEqual(await readClaudeThreadAccount(stateDir, threadId), source);
});

it("removes a partial target revision when copying fails before completion", async () => {
  const root = await mkdtemp(Path.join(tmpdir(), "penkra-claude-partial-copy-"));
  roots.push(root);
  const stateDir = Path.join(root, "state");
  const threadId = "partial-copy-thread";
  const source = {
    authenticationMethodId: "claude-account",
    providerIdentityId: "alice@example.com",
  };
  const target = {
    authenticationMethodId: "claude-account",
    providerIdentityId: "bob@example.com",
  };
  await prepareClaudeThreadProject({
    stateDir,
    threadId,
    configDir: Path.join(root, "source-profile"),
    account: source,
  });
  await writeFile(claudeThreadTranscriptPath(stateDir, threadId, "source-session"), "source");
  const targetRoot = Path.join(
    claudeThreadStateRoot(stateDir, threadId),
    "accounts",
    providerOpaquePathKey("claude-account:bob@example.com"),
    "revision-8",
  );
  await mkdir(targetRoot, { recursive: true });
  await writeFile(Path.join(targetRoot, "project"), "blocks directory copy");
  await assert.rejects(
    stageClaudeThreadAccountTransition({
      stateDir,
      threadId,
      transition: {
        commandId: "partial-copy-command",
        connectionId: "connection-b",
        bindingRevision: 8,
        source,
        target,
      },
    }),
  );
  await discardClaudeThreadAccountTransition({
    stateDir,
    threadId,
    commandId: "partial-copy-command",
  });
  await assert.rejects(access(targetRoot));
  await assert.rejects(
    access(Path.join(claudeThreadStateRoot(stateDir, threadId), "account-transition.json")),
  );
  assert.deepEqual(await readClaudeThreadAccount(stateDir, threadId), source);
});

it("finishes a committed switch after an interrupted owner-marker update", async () => {
  const root = await mkdtemp(Path.join(tmpdir(), "penkra-claude-account-recovery-"));
  roots.push(root);
  const stateDir = Path.join(root, "state");
  const threadId = "recovery-thread";
  const source = {
    authenticationMethodId: "claude-account",
    providerIdentityId: "alice@example.com",
  };
  const target = {
    authenticationMethodId: "claude-account",
    providerIdentityId: "bob@example.com",
  };
  const configA = Path.join(stateDir, "provider-connections", "profile-a", "claude-config");
  const configB = Path.join(stateDir, "provider-connections", "profile-b", "claude-config");
  await prepareClaudeThreadProject({ stateDir, threadId, configDir: configA, account: source });
  await stageClaudeThreadAccountTransition({
    stateDir,
    threadId,
    transition: {
      commandId: "recover-command",
      connectionId: "connection-b",
      bindingRevision: 8,
      source,
      target,
    },
  });
  // Recover a committed binding with the new owner already written and a
  // stale source link still present.
  await writeFile(
    Path.join(claudeThreadStateRoot(stateDir, threadId), "account.json"),
    JSON.stringify(target),
  );
  await prepareClaudeThreadProject({
    stateDir,
    threadId,
    configDir: configB,
    account: target,
    connectionId: "connection-b",
    bindingConnectionId: "connection-b",
    bindingRevision: 8,
  });
  assert.deepEqual(await readClaudeThreadAccount(stateDir, threadId), {
    ...target,
    projectRevision: 8,
  });
  await assert.rejects(access(Path.join(configA, "projects", claudeThreadProjectName(threadId))));
  await assert.rejects(
    access(Path.join(claudeThreadStateRoot(stateDir, threadId), "account-transition.json")),
  );
});

it("does not replace another pending Claude account transition", async () => {
  const root = await mkdtemp(Path.join(tmpdir(), "penkra-claude-account-switch-pending-"));
  roots.push(root);
  const stateDir = Path.join(root, "state");
  const threadId = "pending-switch-thread";
  const source = {
    authenticationMethodId: "claude-account",
    providerIdentityId: "alice@example.com",
  };
  const target = {
    authenticationMethodId: "claude-account",
    providerIdentityId: "bob@example.com",
  };
  await prepareClaudeThreadProject({
    stateDir,
    threadId,
    configDir: Path.join(root, "profile-a"),
    account: source,
  });
  const transition = {
    commandId: "first-command",
    connectionId: "connection-b",
    bindingRevision: 8,
    source,
    target,
  };
  await stageClaudeThreadAccountTransition({ stateDir, threadId, transition });
  await stageClaudeThreadAccountTransition({ stateDir, threadId, transition });
  await assert.rejects(
    stageClaudeThreadAccountTransition({
      stateDir,
      threadId,
      transition: { ...transition, commandId: "second-command" },
    }),
    /different Claude account transition is already pending/,
  );
  await discardClaudeThreadAccountTransition({
    stateDir,
    threadId,
    commandId: "second-command",
  });
  await prepareClaudeThreadProject({
    stateDir,
    threadId,
    configDir: Path.join(root, "profile-b"),
    account: target,
    connectionId: "connection-b",
    bindingConnectionId: "connection-b",
    bindingRevision: 8,
  });
  assert.deepEqual(await readClaudeThreadAccount(stateDir, threadId), {
    ...target,
    projectRevision: 8,
  });
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
