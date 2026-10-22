import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@penkra/contracts";

import { makeAgentGatewaySessionRegistry } from "./AgentGatewaySessionRegistry.ts";

describe("AgentGatewaySessionRegistry", () => {
  it("attributes native sessions only within their registered process and revokes both boundaries", () => {
    let id = 0;
    const registry = makeAgentGatewaySessionRegistry({ randomId: () => String(++id) });
    const a = registry.issue(ThreadId.makeUnsafe("thread-a"), "opencode", "generation-a");
    const b = registry.issue(ThreadId.makeUnsafe("thread-b"), "opencode", "generation-b");
    const processA = registry.processes.issue("opencode");
    const processB = registry.processes.issue("opencode");
    const releaseA = registry.processes.register(processA, "native-a", a.token);
    registry.processes.register(processB, "native-b", b.token);
    assert.equal(registry.processes.resolve(processA, "native-a"), a.token);
    assert.isNull(registry.processes.resolve(processA, "native-b"));
    assert.isNull(registry.processes.resolve(processB, "native-a"));
    assert.isNull(registry.processes.resolve(processA, "unregistered"));
    assert.isNull(registry.verify(processA));
    assert.throws(() => registry.processes.register(processA, "native-a", b.token));
    const wrongProvider = registry.processes.issue("codex");
    assert.throws(() => registry.processes.register(wrongProvider, "native-a", a.token));
    releaseA();
    assert.isNull(registry.processes.resolve(processA, "native-a"));
    registry.processes.register(processA, "native-a", a.token);
    registry.revoke(a.token);
    assert.isNull(registry.processes.resolve(processA, "native-a"));
    registry.processes.revoke(processB);
    assert.isNull(registry.processes.resolve(processB, "native-b"));
    assert.equal(registry.verify(b.token)?.threadId, "thread-b");
  });
  it("binds only the active execution and rejects an ended or replaced turn", () => {
    let nextId = 0;
    const registry = makeAgentGatewaySessionRegistry({ randomId: () => String(++nextId) });
    const threadId = ThreadId.makeUnsafe("thread-1");
    const issued = registry.issue(threadId, "claudeAgent", "generation-1");
    assert.deepEqual([...issued.capabilities].sort(), ["thread:read", "thread:write"]);
    assert.isNull(registry.bindWriteAuthority(issued.token));

    registry.beginTurn(threadId, "claudeAgent", "turn-1", "generation-1");
    const first = registry.bindWriteAuthority(issued.token);
    assert.equal(first?.turnId, "turn-1");
    assert.isTrue(registry.verifyWriteAuthority(first!));
    registry.beginTurn(threadId, "claudeAgent", "turn-1", "generation-1");
    assert.isTrue(registry.verifyWriteAuthority(first!));
    // A steer reuses the provider execution and therefore retains its grant.
    assert.equal(registry.bindWriteAuthority(issued.token)?.turnId, "turn-1");
    assert.isTrue(registry.verifyWriteAuthority(first!));

    registry.endTurn(threadId, "claudeAgent", "older-turn", "generation-1");
    assert.isTrue(registry.verifyWriteAuthority(first!));
    registry.beginTurn(threadId, "claudeAgent", "turn-2", "generation-1");
    assert.isFalse(registry.verifyWriteAuthority(first!));
    assert.equal(registry.bindWriteAuthority(issued.token)?.turnId, "turn-2");
    registry.beginTurn(threadId, "claudeAgent", "turn-1", "generation-1", "runtime-event");
    registry.beginTurn(threadId, "claudeAgent", "turn-2", "generation-1", "runtime-event");
    assert.equal(registry.bindWriteAuthority(issued.token)?.turnId, "turn-2");
    registry.endTurn(threadId, "claudeAgent", "turn-2", "generation-1");
    assert.isNull(registry.bindWriteAuthority(issued.token));
    registry.beginTurn(threadId, "claudeAgent", "turn-2", "generation-1");
    assert.isNull(registry.bindWriteAuthority(issued.token));
  });

  it("does not grant an outgoing runtime authority over a replacement turn", () => {
    let nextId = 0;
    const registry = makeAgentGatewaySessionRegistry({ randomId: () => String(++nextId) });
    const threadId = ThreadId.makeUnsafe("thread-1");
    const oldSession = registry.issue(threadId, "claudeAgent", "generation-old");
    registry.beginTurn(threadId, "claudeAgent", "turn-old", "generation-old");
    const oldAuthority = registry.bindWriteAuthority(oldSession.token);
    assert.ok(oldAuthority);
    const newSession = registry.issue(threadId, "claudeAgent", "generation-new");

    assert.isNull(registry.bindWriteAuthority(oldSession.token));
    assert.isFalse(registry.verifyWriteAuthority(oldAuthority));
    registry.beginTurn(threadId, "claudeAgent", "reclaim-old", "generation-old");
    assert.isNull(registry.bindWriteAuthority(oldSession.token));
    registry.beginTurn(threadId, "claudeAgent", "turn-new", "generation-new");
    assert.isNull(registry.bindWriteAuthority(oldSession.token));
    assert.isFalse(registry.verifyWriteAuthority(oldAuthority));
    assert.equal(registry.bindWriteAuthority(newSession.token)?.turnId, "turn-new");
    registry.endTurn(threadId, "claudeAgent", "turn-new", "generation-old");
    assert.equal(registry.bindWriteAuthority(newSession.token)?.turnId, "turn-new");
    registry.endSession(threadId, "claudeAgent", "generation-old");
    assert.equal(registry.bindWriteAuthority(newSession.token)?.turnId, "turn-new");
  });

  it("allows independent legitimate sessions for the same thread", () => {
    let nextId = 0;
    const registry = makeAgentGatewaySessionRegistry({ randomId: () => String(++nextId) });
    const first = registry.issue(ThreadId.makeUnsafe("thread-1"), "codex");
    const second = registry.issue(ThreadId.makeUnsafe("thread-1"), "claudeAgent");
    assert.notEqual(first.token, second.token);
    assert.equal(registry.verify(first.token)?.threadId, "thread-1");
    assert.equal(registry.verify(second.token)?.threadId, "thread-1");
    assert.equal(registry.verify(first.token)?.provider, "codex");
    assert.equal(registry.verify(second.token)?.provider, "claudeAgent");
  });

  it("keeps replacement runtime credentials independent from outgoing-session revocation", () => {
    let nextId = 0;
    const registry = makeAgentGatewaySessionRegistry({ randomId: () => String(++nextId) });
    const first = registry.issue(ThreadId.makeUnsafe("thread-1"), "codex");
    const second = registry.issue(ThreadId.makeUnsafe("thread-1"), "codex");
    assert.notEqual(first.token, second.token);
    assert.equal(registry.verify(first.token)?.threadId, "thread-1");
    assert.equal(registry.verify(second.token)?.threadId, "thread-1");

    registry.revoke(first.token);
    assert.isNull(registry.verify(first.token));
    assert.equal(registry.verify(second.token)?.threadId, "thread-1");
  });

  it("binds writes to one live provider session and invalidates that authority on revoke", () => {
    const registry = makeAgentGatewaySessionRegistry({ randomId: () => "session-one" });
    const issued = registry.issue(ThreadId.makeUnsafe("thread-1"), "codex");
    registry.beginTurn(issued.threadId, "codex", "turn-1");
    const authority = registry.bindWriteAuthority(issued.token);

    assert.deepEqual(authority, {
      sessionKey: issued.sessionKey,
      threadId: issued.threadId,
      provider: "codex",
      turnId: "turn-1",
    });
    assert.isTrue(registry.verifyWriteAuthority(authority!));
    assert.isFalse(
      registry.verifyWriteAuthority({ ...authority!, turnId: "turn-2", provider: "opencode" }),
    );

    registry.revoke(issued.token);
    assert.isFalse(registry.verifyWriteAuthority(authority!));
  });

  it("keeps credentials valid for a long-lived provider session but not across restart", () => {
    let time = 1_000;
    const firstRegistry = makeAgentGatewaySessionRegistry({
      now: () => time,
      randomId: () => "first",
    });
    const issued = firstRegistry.issue(ThreadId.makeUnsafe("thread-1"), "codex");
    time += 48 * 60 * 60 * 1_000;
    assert.equal(firstRegistry.verify(issued.token)?.threadId, "thread-1");

    const afterRestart = makeAgentGatewaySessionRegistry({ randomId: () => "second" });
    assert.isNull(afterRestart.verify(issued.token));
  });

  it("keeps raw bearer tokens out of verified session identity snapshots", () => {
    const registry = makeAgentGatewaySessionRegistry({ randomId: () => "opaque-secret" });
    const issued = registry.issue(ThreadId.makeUnsafe("thread-1"), "codex");
    const verified = registry.verify(issued.token);
    assert.match(issued.token, /^sagw_session_/);
    assert.notProperty(verified, "token");
    assert.notInclude(JSON.stringify(verified), issued.token);
  });
});
