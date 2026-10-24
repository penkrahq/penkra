import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { ThreadId, type ProviderEvent } from "@penkra/contracts";
import { expect, it, vi } from "vitest";
import { Effect } from "effect";
import {
  CodexAppServerManager,
  CodexStderrLineFramer,
  CodexStderrRecordFramer,
} from "./codexAppServerManager";
import { CodexJsonlFramer, CodexJsonlWriter } from "./codexAppServerTransport";
import {
  ProviderProcessExitUnprovenError,
  type SupervisedProcessTeardownInput,
  type SupervisedProcessTeardownResult,
} from "./provider/supervisedProcessTeardown";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(
  teardown: (input: SupervisedProcessTeardownInput) => Promise<SupervisedProcessTeardownResult>,
) {
  class Child extends EventEmitter {
    pid = 5544;
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    killed = false;
    stdin = new PassThrough();
    stdout = new PassThrough();
    stderr = new PassThrough();
  }
  const child = new Child();
  const manager = new CodexAppServerManager(undefined, { teardownProcessTree: teardown });
  const events: ProviderEvent[] = [];
  manager.on("event", (event) => events.push(event));
  const transport = {
    key: "account",
    token: Symbol("account"),
    cwd: "/workspace",
    binaryPath: "/managed/codex",
    connectionIds: new Set(),
    threads: new Set<unknown>(),
    probes: new Map(),
    pendingCloses: new Map(),
    stopping: false,
    protocolClosed: false,
    protocolFailure: undefined as Error | undefined,
    child,
    account: { type: "unknown", planType: null, sparkEnabled: true },
    stdoutFramer: new CodexJsonlFramer(),
    stdinWriter: new CodexJsonlWriter(child.stdin),
    pending: new Map(),
    nextRequestId: 1,
    mcpStartupStatuses: new Map(),
    reportedMcpStartupFailures: new Set(),
    stderrLineFramer: new CodexStderrLineFramer(),
    stderrRecordFramer: new CodexStderrRecordFramer(),
  };
  const threadId = ThreadId.make("shutdown-thread");
  const context = {
    transport,
    session: {
      provider: "codex",
      status: "ready",
      threadId,
      runtimeMode: "full-access",
      createdAt: "2026-10-12T00:00:00.000Z",
      updatedAt: "2026-10-12T00:00:00.000Z",
    },
    pendingUserInputs: new Map(),
    collabReceiverTurns: new Map(),
    collabReceiverParents: new Map(),
    reviewTurnIds: new Set(),
    terminalTurnIds: new Set(),
    stopping: false,
  };
  transport.threads.add(context);
  const internals = manager as unknown as {
    sessions: Map<ThreadId, unknown>;
    accountProcesses: Map<string, { token: symbol; process: Promise<unknown> }>;
    attachProcessListeners: (transport: unknown) => void;
    closeAccountProcess: (transport: unknown) => Promise<void>;
    terminateAccountProcess: (transport: unknown) => Promise<unknown>;
    sendRequest: (
      transport: unknown,
      owner: ThreadId | null,
      method: string,
      params: unknown,
    ) => Promise<unknown>;
    getOrCreateAccountProcess: (input: unknown) => Promise<unknown>;
    startAccountProcess: (input: unknown, token: symbol) => Promise<unknown>;
  };
  internals.sessions.set(threadId, context);
  internals.accountProcesses.set(transport.key, {
    token: transport.token,
    process: Promise.resolve(transport),
  });
  internals.attachProcessListeners(transport);
  const request = () => internals.sendRequest(transport, threadId, "thread/read", {});
  const close = (code: number) => {
    child.exitCode = code;
    child.emit("exit", code, null);
    child.stderr.emit("end");
    child.emit("close", code, null);
  };
  return { child, manager, internals, transport, events, request, close };
}

it("terminates a live child after stdout closes and reports the drained stderr once", async () => {
  const proof = deferred<SupervisedProcessTeardownResult>();
  const terminate = vi.fn(() => proof.promise);
  const f = fixture(terminate);
  const result = f.request().catch((error) => error);
  f.child.stdout.emit("end");
  expect(terminate).toHaveBeenCalledTimes(1);
  expect(f.manager.hasSession(ThreadId.make("shutdown-thread"))).toBe(false);
  await expect(f.request()).rejects.toThrow("protocol is closed");
  f.child.stderr.write("fatal: auth refused\n");
  f.close(7);
  const error = await result;
  assert(error instanceof Error);
  expect(error.message).toContain("auth refused");
  expect(error.message).toContain("code=7");
  expect(f.events.filter((event) => event.method === "session/exited")).toHaveLength(1);
  // Native close alone cannot lift the tree-proof barrier.
  expect(f.internals.accountProcesses.has("account")).toBe(true);
  proof.resolve({ escalated: false, signalErrors: [] });
  await f.internals.terminateAccountProcess(f.transport);
  expect(f.internals.accountProcesses.has("account")).toBe(false);
});

it("a requested stop wins over stdout closure and emits no exit error", async () => {
  const proof = deferred<SupervisedProcessTeardownResult>();
  const entered = deferred<void>();
  const terminate = vi.fn(() => {
    entered.resolve();
    return proof.promise;
  });
  const f = fixture(terminate);
  const result = f.request().catch((error) => error);
  const stopping = f.internals.closeAccountProcess(f.transport);
  await entered.promise;
  f.child.stdout.emit("end");
  f.close(0);
  expect(f.events.filter((event) => event.method === "session/closed")).toEqual([]);
  proof.resolve({ escalated: false, signalErrors: [] });
  await stopping;
  const error = await result;
  assert(error instanceof Error);
  expect(error.message).toBe("Codex account process stopped");
  expect(terminate).toHaveBeenCalledTimes(1);
  expect(f.events.filter((event) => event.method === "session/closed")).toHaveLength(1);
  expect(
    f.events.filter((event) => event.kind === "error" || event.method === "session/exited"),
  ).toEqual([]);
});

it("reports a normal exit once without invoking termination", async () => {
  const terminate = vi.fn(async () => ({ escalated: false, signalErrors: [] }));
  const f = fixture(terminate);
  const result = f.request().catch((error) => error);
  f.close(3);
  const error = await result;
  assert(error instanceof Error);
  expect(error.message).toContain("code=3");
  expect(terminate).not.toHaveBeenCalled();
  expect(f.events.filter((event) => event.method === "session/exited")).toHaveLength(1);
});

it("reports failed tree proof without claiming exit and retries proof before respawn", async () => {
  const first = deferred<SupervisedProcessTeardownResult>();
  const second = deferred<SupervisedProcessTeardownResult>();
  const terminate = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const f = fixture(terminate);
  const result = f.request().catch((error) => error);
  const probeReject = vi.fn();
  f.transport.probes.set("probe", { reject: probeReject });
  f.child.stderr.write("fatal: refused\n");
  f.child.stdout.emit("end");
  const error = new ProviderProcessExitUnprovenError({
    rootPid: f.child.pid,
    rootExited: false,
    remainingDescendantPids: [5545],
    captureComplete: true,
  });
  first.reject(error);
  expect(await result).toBe(error);
  expect(error.message).toContain("5544");
  expect(error.message).toContain("refused");
  expect(probeReject).toHaveBeenCalledOnce();
  expect(probeReject).toHaveBeenCalledWith(error);
  expect(f.events.filter((event) => event.method === "session/exited")).toEqual([]);
  expect(f.events.filter((event) => event.kind === "error")).toHaveLength(1);
  f.close(1);
  expect(f.events.filter((event) => event.method === "session/exited")).toEqual([]);
  expect(f.events.filter((event) => event.kind === "error")).toHaveLength(1);
  expect(f.internals.accountProcesses.has("account")).toBe(true);
  expect(f.child.listenerCount("close")).toBe(0);
  const replacement = { key: "replacement" };
  const spawn = vi.spyOn(f.internals, "startAccountProcess").mockResolvedValue(replacement);
  const admission = {
    assertCurrentCredentials: Effect.void,
    key: "account",
    cwd: "/workspace",
    binaryPath: "/managed/codex",
    env: {},
    connectionId: null,
  };
  const retiring = f.internals.getOrCreateAccountProcess(admission).catch((error) => error);
  await Promise.resolve();
  expect(spawn).not.toHaveBeenCalled();
  second.resolve({ escalated: true, signalErrors: [] });
  expect(await retiring).toBe(f.transport.protocolFailure);
  expect(terminate).toHaveBeenCalledTimes(2);
  expect(spawn).not.toHaveBeenCalled();
  expect(await f.internals.getOrCreateAccountProcess(admission)).toBe(replacement);
  expect(spawn).toHaveBeenCalledOnce();
});

it.each(["proof-first", "close-first"])(
  "acquisition preserves the final error and waits for both completions (%s)",
  async (order) => {
    const proof = deferred<SupervisedProcessTeardownResult>();
    const f = fixture(() => proof.promise);
    const rejected = vi.fn();
    const result = f.request().catch((error) => {
      rejected(error);
      return error;
    });
    f.child.stdout.emit("end");
    const replacement = { key: "replacement" };
    const spawn = vi.spyOn(f.internals, "startAccountProcess").mockResolvedValue(replacement);
    const admission = {
      assertCurrentCredentials: Effect.void,
      key: "account",
      cwd: "/workspace",
      binaryPath: "/managed/codex",
      env: {},
      connectionId: null,
    };
    const acquiring = f.internals.getOrCreateAccountProcess(admission).catch((error) => error);
    // Let acquisition consume the already-resolved account entry.
    await Promise.resolve();
    expect(spawn).not.toHaveBeenCalled();
    if (order === "proof-first") {
      proof.resolve({ escalated: false, signalErrors: [] });
      await f.internals.terminateAccountProcess(f.transport);
      expect(spawn).not.toHaveBeenCalled();
    }
    f.child.stderr.write("fatal: selected account refused\n");
    f.close(9);
    const error = await result;
    assert(error instanceof Error);
    expect(error.message).toContain("selected account refused");
    expect(error.message).toContain("code=9");
    expect(error.message).not.toContain("account process stopped");
    expect(rejected).toHaveBeenCalledOnce();
    if (order === "close-first") {
      expect(spawn).not.toHaveBeenCalled();
      proof.resolve({ escalated: false, signalErrors: [] });
    }
    expect(await acquiring).toBe(f.transport.protocolFailure);
    expect(spawn).not.toHaveBeenCalled();
    expect(await f.internals.getOrCreateAccountProcess(admission)).toBe(replacement);
    expect(spawn).toHaveBeenCalledOnce();
  },
);

it("acquisition rethrows a failed proof and keeps the account barrier", async () => {
  const proof = deferred<SupervisedProcessTeardownResult>();
  const f = fixture(() => proof.promise);
  const result = f.request().catch((error) => error);
  f.child.stdout.emit("end");
  const spawn = vi.spyOn(f.internals, "startAccountProcess");
  const acquiring = f.internals
    .getOrCreateAccountProcess({
      assertCurrentCredentials: Effect.void,
      key: "account",
      cwd: "/workspace",
      binaryPath: "/managed/codex",
      env: {},
      connectionId: null,
    })
    .catch((error) => error);
  await Promise.resolve();
  const error = new ProviderProcessExitUnprovenError({
    rootPid: f.child.pid,
    rootExited: false,
    remainingDescendantPids: [5545],
    captureComplete: true,
  });
  proof.reject(error);
  expect(await acquiring).toBe(error);
  expect(await result).toBe(error);
  expect(spawn).not.toHaveBeenCalled();
  expect(f.internals.accountProcesses.has("account")).toBe(true);
  f.close(1);
  expect(f.internals.accountProcesses.has("account")).toBe(true);
});
