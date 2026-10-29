import { describe, expect, it, vi } from "vitest";
import {
  mapCodexRuntimeMode,
  mapCodexRuntimeModeToTurnOverrides,
} from "./codexAppServerManager.ts";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { MessageId, type ProviderEvent, ThreadId, TurnId } from "@penkra/contracts";

import * as executableLookup from "./executableLookup.ts";
import { buildCodexProcessEnv } from "./codexProcessEnv";
import {
  buildCodexInitializeParams,
  buildCodexDynamicTools,
  buildCodexThreadMcpConfig,
  CODEX_DEVELOPER_INSTRUCTIONS,
  CodexSessionStoppedRequestError,
  __codexCliVersionGateTesting,
  CodexAppServerManager,
  CodexJsonRpcResponseError,
  classifyCodexStderrRecord,
  CodexStderrLineFramer,
  CodexStderrRecordFramer,
  normalizeCodexModelSlug,
  readCodexAccountSnapshot,
  recordCodexCapabilityPreflightFailure,
  resumeCodexThreadWithoutHistoryReplay,
  resolveCodexModelForAccount,
} from "./codexAppServerManager";
import {
  assertCodexWorkingDirectoryExists,
  CodexWorkingDirectoryAccessError,
  formatInaccessibleCodexWorkingDirectoryError,
  formatMissingCodexWorkingDirectoryError,
} from "./codexWorkingDirectory";
import {
  CodexAppServerTransportError,
  CodexJsonlFramer,
  CodexJsonlWriter,
  CodexResponseTooLargeError,
} from "./codexAppServerTransport";
import { ensureDurableThreadWorkspace } from "./scratchWorkspaces";
import { acquireAgentGatewaySessionLease } from "./agentGateway/sessionLease.ts";

function closeProcessForTest(manager: CodexAppServerManager, transport: unknown): Promise<void> {
  return (
    manager as unknown as { closeAccountProcess: (transport: unknown) => Promise<void> }
  ).closeAccountProcess(transport);
}

const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const fullAccessTurnOverrides = {
  approvalPolicy: "never",
  sandboxPolicy: { type: "dangerFullAccess" },
} as const;
const approvalRequiredTurnOverrides = {
  approvalPolicy: "untrusted",
  sandboxPolicy: { type: "readOnly" },
} as const;

describe("failed Codex thread stop detachment", () => {
  it("does not issue a queued native turn after its session starts stopping", async () => {
    const manager = new CodexAppServerManager();
    const internals = manager as unknown as {
      sessions: Map<ThreadId, unknown>;
      withNativeTurnStart(context: unknown, start: () => Promise<void>): Promise<void>;
    };
    let release!: () => void;
    const previous = new Promise<void>((resolve) => {
      release = resolve;
    });
    const threadId = asThreadId("queued-before-stop");
    const context = {
      transport: { stopping: false },
      session: { threadId },
      stopping: false,
      nativeTurnStartTail: previous,
    };
    internals.sessions.set(threadId, context);
    const start = vi.fn(async () => undefined);
    const queued = internals.withNativeTurnStart(context, start);
    context.stopping = true;
    release();
    await expect(queued).rejects.toBeInstanceOf(CodexSessionStoppedRequestError);
    expect(start).not.toHaveBeenCalled();
  });
  it.each(["exact", "other-thread", "other-turn", "none", "pending-start"])(
    "distinguishes local detachment from active-turn termination (%s proof)",
    async (proof) => {
      const manager = new CodexAppServerManager();
      const internals = manager as unknown as {
        sessions: Map<ThreadId, unknown>;
        settlePendingHumanRequests(context: unknown, reason: string): Promise<void>;
        sendRequest(...args: unknown[]): Promise<unknown>;
        handleStdoutLine(transport: unknown, line: string): void;
      };
      const transport = {
        threads: new Set<unknown>(),
        pending: new Map(),
        probes: new Map(),
        connectionIds: new Set(),
        stopping: false,
      };
      const context = {
        transport,
        stopping: false,
        pendingUserInputs: new Map(),
        terminalTurnIds: new Set(),
        session: {
          threadId: asThreadId("active-stop"),
          provider: "codex",
          status: "running",
          activeTurnId: proof === "pending-start" ? undefined : asTurnId("active-turn"),
          resumeCursor: { threadId: "active-native" },
        },
        ...(proof === "pending-start" ? { nativeTurnStartTail: Promise.resolve() } : {}),
      };
      transport.threads.add(context);
      internals.sessions.set(context.session.threadId, context);
      const settle = vi.spyOn(internals, "settlePendingHumanRequests").mockResolvedValue(undefined);
      const send = vi
        .spyOn(internals, "sendRequest")
        .mockImplementation(async (_transport, _owner, method) => {
          if (method === "turn/interrupt" && proof !== "none")
            internals.handleStdoutLine(
              transport,
              JSON.stringify({
                method: "turn/completed",
                params: {
                  threadId: proof === "other-thread" ? "another-native" : "active-native",
                  turn: {
                    id: proof === "other-turn" ? "another-turn" : "active-turn",
                    status: "interrupted",
                  },
                },
              }),
            );
          return method === "thread/unsubscribe" ? { status: "unsubscribed" } : {};
        });
      try {
        const stop = manager.stopSession(context.session.threadId);
        if (proof === "exact") await expect(stop).resolves.toBeUndefined();
        else await expect(stop).rejects.toThrow("without confirming the active turn ended");
        expect(internals.sessions.has(context.session.threadId)).toBe(false);
        expect(transport.stopping).toBe(false);
        expect(send.mock.calls.map((call) => call[2])).toEqual(
          proof === "pending-start"
            ? ["thread/unsubscribe"]
            : ["turn/interrupt", "thread/unsubscribe"],
        );
      } finally {
        settle.mockRestore();
        send.mockRestore();
      }
    },
  );
  it.each(["unsubscribed", "notSubscribed", "notLoaded"])(
    "finishes local stop on %s without awaiting native unload",
    async (status) => {
      const manager = new CodexAppServerManager();
      const internals = manager as unknown as {
        sessions: Map<ThreadId, unknown>;
        settlePendingHumanRequests(context: unknown, reason: string): Promise<void>;
        sendRequest(...args: unknown[]): Promise<unknown>;
      };
      const transport = {
        threads: new Set<unknown>(),
        pending: new Map(),
        stopping: false,
      };
      const context = {
        transport,
        session: {
          threadId: asThreadId("acknowledged-stop"),
          provider: "codex",
          status: "ready",
          resumeCursor: { threadId: "native-acknowledged" },
        },
        pendingUserInputs: new Map(),
        stopping: false,
      };
      transport.threads.add(context);
      internals.sessions.set(context.session.threadId, context);
      const settle = vi.spyOn(internals, "settlePendingHumanRequests").mockResolvedValue(undefined);
      const send = vi.spyOn(internals, "sendRequest").mockResolvedValue({ status });
      try {
        await manager.stopSession(context.session.threadId);
        expect(send).toHaveBeenCalledWith(
          transport,
          context.session.threadId,
          "thread/unsubscribe",
          { threadId: "native-acknowledged" },
        );
        expect(internals.sessions.has(context.session.threadId)).toBe(false);
        expect(transport.threads.has(context)).toBe(false);
        expect(transport.stopping).toBe(false);
      } finally {
        settle.mockRestore();
        send.mockRestore();
      }
    },
    1000,
  );

  it.each([false, true])(
    "detaches only the failed context (replacement attached: %s)",
    async (replace) => {
      const manager = new CodexAppServerManager();
      const internals = manager as unknown as {
        sessions: Map<ThreadId, unknown>;
        settlePendingHumanRequests(context: unknown, reason: string): Promise<void>;
      };
      const transport = {
        threads: new Set<unknown>(),
        pending: new Map(),
        stopping: false,
      };
      const release = vi.fn();
      const context = {
        transport,
        session: {
          threadId: asThreadId("failed-stop"),
          provider: "codex",
          status: "ready",
          resumeCursor: { threadId: "retired-native" },
        },
        pendingUserInputs: new Map([["pending-input", {}]]),
        gatewaySessionLease: { release },
        stopping: false,
      };
      const peer = {
        transport,
        session: { threadId: asThreadId("unaffected-peer"), provider: "codex", status: "ready" },
        stopping: false,
      };
      transport.threads.add(context);
      transport.threads.add(peer);
      internals.sessions.set(context.session.threadId, context);
      internals.sessions.set(peer.session.threadId, peer);
      const replacement = { ...peer, session: context.session };
      const rejectReplacementRequest = vi.fn();
      const failure = new Error("controlled settlement failure");
      const settle = vi.spyOn(internals, "settlePendingHumanRequests").mockImplementation(() => {
        if (replace) {
          internals.sessions.set(context.session.threadId, replacement);
          transport.threads.add(replacement);
          transport.pending.set(42, {
            ownerThreadId: context.session.threadId,
            timeout: undefined,
            reject: rejectReplacementRequest,
          });
        }
        return Promise.reject(failure);
      });
      const events: ProviderEvent[] = [];
      manager.on("event", (event) => events.push(event));
      try {
        await expect(manager.stopSession(context.session.threadId)).rejects.toBe(failure);
        expect(internals.sessions.get(context.session.threadId)).toBe(
          replace ? replacement : undefined,
        );
        expect(transport.threads.has(context)).toBe(false);
        expect(context.pendingUserInputs.size).toBe(0);
        expect(release).toHaveBeenCalledTimes(1);
        expect(internals.sessions.get(peer.session.threadId)).toBe(peer);
        expect(transport.threads.has(peer)).toBe(true);
        expect(transport.stopping).toBe(false);
        expect(transport.threads.has(replacement)).toBe(replace);
        expect(rejectReplacementRequest).not.toHaveBeenCalled();
        expect(events.filter((event) => event.method === "session/closed")).toEqual([]);
      } finally {
        settle.mockRestore();
      }
    },
  );
});

describe("Codex capability preflight logging", () => {
  it("rejects only an oversized catalog response while another thread continues streaming", async () => {
    class FakeCodexChild extends EventEmitter {
      readonly pid = 42;
      exitCode = null;
      signalCode = null;
      killed = false;
      readonly stdin = new PassThrough();
      readonly stdout = new PassThrough();
      readonly stderr = new PassThrough();
    }
    const child = new FakeCodexChild();
    const manager = new CodexAppServerManager();
    const internals = manager as unknown as {
      sessions: Map<ThreadId, unknown>;
      attachProcessListeners(transport: unknown): void;
      terminateAccountProcess(transport: unknown): Promise<void>;
      sendRequest(
        transport: unknown,
        owner: ThreadId | null,
        method: string,
        params: unknown,
      ): Promise<unknown>;
    };
    const transport = {
      child,
      key: "account",
      token: Symbol("account"),
      stopping: false,
      protocolClosed: false,
      threads: new Set<unknown>(),
      probes: new Map(),
      pending: new Map(),
      stdoutFramer: new CodexJsonlFramer(256),
      stdinWriter: new CodexJsonlWriter(child.stdin),
      stderrLineFramer: new CodexStderrLineFramer(),
      stderrRecordFramer: new CodexStderrRecordFramer(),
      nextRequestId: 1,
    };
    const context = {
      transport,
      stopping: false,
      session: {
        threadId: asThreadId("running-thread"),
        provider: "codex",
        status: "running",
        activeTurnId: asTurnId("turn-b"),
        resumeCursor: { threadId: "native-b" },
      },
      collabReceiverTurns: new Map(),
      collabReceiverParents: new Map(),
      terminalTurnIds: new Set(),
      reviewTurnIds: new Set(),
    };
    transport.threads.add(context);
    internals.sessions.set(context.session.threadId, context);
    const terminate = vi.spyOn(internals, "terminateAccountProcess").mockResolvedValue(undefined);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const events: ProviderEvent[] = [];
    manager.on("event", (event) => events.push(event));
    internals.attachProcessListeners(transport);
    const catalog = internals
      .sendRequest(transport, null, "plugin/list", {})
      .catch((error) => error);
    const models = internals.sendRequest(transport, null, "model/list", {});
    try {
      // Finish the real queued writes before injecting the fake child's replies.
      await transport.stdinWriter.write({ method: "initialized" });
      child.stdout.write(
        JSON.stringify({ id: 1, result: { privatePayload: "x".repeat(600) } }) +
          "\n" +
          JSON.stringify({
            method: "item/agentMessage/delta",
            params: {
              threadId: "native-b",
              turnId: "turn-b",
              itemId: "message-b",
              delta: "still working",
            },
          }) +
          "\n" +
          JSON.stringify({ id: 2, result: { models: [] } }) +
          "\n",
      );
      const error = await catalog;
      expect(error).toBeInstanceOf(CodexResponseTooLargeError);
      expect(error).toMatchObject({ method: "plugin/list", requestId: 1 });
      expect(error).toHaveProperty(
        "message",
        "Codex's reply to plugin/list was larger than 16 MiB.",
      );
      expect(error).not.toHaveProperty("requestOutcome");
      await expect(models).resolves.toEqual({ models: [] });
      expect(transport.pending.size).toBe(0);
      expect(transport.protocolClosed).toBe(false);
      expect(terminate).not.toHaveBeenCalled();
      expect(manager.hasSession(context.session.threadId)).toBe(true);
      expect(context.session.status).toBe("running");
      expect(events).toEqual([
        expect.objectContaining({
          method: "item/agentMessage/delta",
          threadId: context.session.threadId,
          payload: expect.objectContaining({ delta: "still working" }),
        }),
      ]);
      expect(warning).toHaveBeenCalledOnce();
      expect(warning.mock.calls[0]![0]).toContain('method="plugin/list"');
      expect(warning.mock.calls[0]![0]).not.toContain("privatePayload");
      child.stdout.write(JSON.stringify({ id: 1, result: "x".repeat(600) }) + "\n");
      expect(manager.hasSession(context.session.threadId)).toBe(true);
      expect(warning).toHaveBeenCalledTimes(2);
    } finally {
      child.stdin.end();
      warning.mockRestore();
      terminate.mockRestore();
    }
  });
});

describe("Codex Penkra harness policy", () => {
  it("probes Responses with an isolated read-only turn and requires completion", async () => {
    const manager = new CodexAppServerManager();
    const context = {
      probes: new Map<string, { resolve: (success: boolean) => void }>(),
      authProbeThreadId: undefined as string | undefined,
    };
    vi.spyOn(
      manager as unknown as {
        getOrCreateManagedProcess: (...args: unknown[]) => Promise<unknown>;
      },
      "getOrCreateManagedProcess",
    ).mockResolvedValue(context);
    const sendRequest = vi
      .spyOn(
        manager as unknown as {
          sendRequest: (...args: unknown[]) => Promise<unknown>;
        },
        "sendRequest",
      )
      .mockResolvedValueOnce({ thread: { id: "native-auth-probe" } } as never)
      .mockResolvedValueOnce({ turn: { id: "probe-turn", status: "completed" } } as never)
      .mockResolvedValueOnce({ turn: { id: "probe-turn-2", status: "failed" } } as never)
      .mockResolvedValueOnce({ turn: { id: "probe-turn-3", status: "inProgress" } } as never);
    const input = { cwd: "/tmp", managedLaunch: {} as never, model: "catalog-luna", effort: "low" };
    expect(await manager.probeResponses(input)).toBe(true);
    expect(await manager.probeResponses(input)).toBe(false);
    const pendingProbe = manager.probeResponses(input);
    await Promise.resolve();
    await Promise.resolve();
    context.probes.get("native-auth-probe")!.resolve(true);
    expect(await pendingProbe).toBe(true);
    expect(sendRequest.mock.calls.map((call) => call[2])).toEqual([
      "thread/start",
      "turn/start",
      "turn/start",
      "turn/start",
    ]);
    expect(sendRequest.mock.calls[0]?.[3]).toMatchObject({
      model: "catalog-luna",
      approvalPolicy: "untrusted",
      sandbox: "read-only",
      dynamicTools: [],
      environments: [],
      ephemeral: true,
    });
    expect(sendRequest.mock.calls[1]?.[3]).toMatchObject({
      threadId: "native-auth-probe",
      model: "catalog-luna",
      effort: "low",
      approvalPolicy: "untrusted",
      sandboxPolicy: { type: "readOnly" },
    });
  });
  it("keeps the Penkra host tool out of Codex MCP configuration", async () => {
    const homePath = mkdtempSync(path.join(os.tmpdir(), "penkra-codex-gateway-endpoint-"));
    const previousPenkraHome = process.env.PENKRA_HOME;
    process.env.PENKRA_HOME = path.join(homePath, "penkra-home");
    try {
      const manager = new CodexAppServerManager(undefined, {
        agentGatewayHostTool: {
          acquireSessionLease: () => ({
            connection: {
              url: "http://unused.invalid/mcp",
              bearerToken: "token",
            },
            release: () => undefined,
          }),
          requireNativeSurface: () => ({
            definitions: [],
            invoke: async () => ({ content: [] }),
          }),
        },
      });
      const env = await (
        manager as unknown as {
          buildSessionProcessEnv: (homePath: string | undefined) => Promise<NodeJS.ProcessEnv>;
        }
      ).buildSessionProcessEnv(homePath);
      const configPath = path.join(env.CODEX_HOME ?? homePath, "config.toml");
      expect(readFileSync(configPath, "utf8")).not.toContain("mcp_servers.penkra");
      expect(env.PENKRA_AGENT_GATEWAY_TOKEN).toBeUndefined();
    } finally {
      if (previousPenkraHome === undefined) {
        delete process.env.PENKRA_HOME;
      } else {
        process.env.PENKRA_HOME = previousPenkraHome;
      }
      rmSync(homePath, { recursive: true, force: true });
    }
  });

  it("builds distinct thread-scoped MCP headers from each lease", () => {
    expect(
      buildCodexThreadMcpConfig({ url: "http://gateway.test/mcp", bearerToken: "start-lease" }),
    ).toEqual({
      "mcp_servers.penkra": {
        url: "http://gateway.test/mcp",
        http_headers: { Authorization: "Bearer start-lease" },
      },
    });
    expect(
      buildCodexThreadMcpConfig({ url: "http://gateway.test/mcp", bearerToken: "sibling-lease" }),
    ).toEqual({
      "mcp_servers.penkra": {
        url: "http://gateway.test/mcp",
        http_headers: { Authorization: "Bearer sibling-lease" },
      },
    });
  });

  it("dispatches Codex dynamic-tool calls through the authenticated native surface", async () => {
    const resourceRoot = mkdtempSync(path.join(os.tmpdir(), "penkra-codex-tool-resource-"));
    const invoke = vi.fn().mockResolvedValue({
      content: [
        { type: "text", text: '{"ok":true}' },
        { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
        {
          type: "resource",
          resource: {
            uri: "penkra-app-resource://whatsapp/attachment-1/fees.pdf",
            name: "fees.pdf",
            mimeType: "application/pdf",
            blob: "cGRmLWJ5dGVz",
          },
        },
      ],
    });
    const manager = new CodexAppServerManager(undefined, {
      agentGatewayHostTool: {
        acquireSessionLease: () => ({
          connection: {
            url: "http://unused.invalid/mcp",
            bearerToken: "thread-token",
          },
          release: () => undefined,
        }),
        requireNativeSurface: () => ({ definitions: [], invoke }),
      },
    });
    const context = {
      transport: {
        key: "test-account",
        cwd: "test-cwd",
        connectionIds: new Set(),
        token: Symbol("test-account"),
        threads: new Set<unknown>(),
        probes: new Map(),
        stopping: false,
      },
      gatewaySessionLease: {
        connection: {
          url: "http://unused.invalid/mcp",
          bearerToken: "thread-token",
        },
        release: () => undefined,
      },
      session: {
        provider: "codex",
        status: "running",
        activeTurnId: asTurnId("turn-native"),
        threadId: asThreadId("thread-native-tool"),
        runtimeMode: "full-access",
        cwd: resourceRoot,
        resumeCursor: { threadId: "provider-thread-native" },
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:00.000Z",
      },
      pendingUserInputs: new Map(),
      collabReceiverTurns: new Map(),
      collabReceiverParents: new Map(),
      reviewTurnIds: new Set(),
      terminalTurnIds: new Set(),
      temporaryResourcePaths: new Map(),
      stopping: false,
    };
    context.transport.threads.add(context);
    vi.spyOn(
      manager as unknown as { emitEvent: (...args: unknown[]) => void },
      "emitEvent",
    ).mockImplementation(() => {});
    const writeMessage = vi
      .spyOn(
        manager as unknown as {
          writeMessage: (...args: unknown[]) => Promise<void>;
        },
        "writeMessage",
      )
      .mockResolvedValue(undefined);

    await handleServerRequestForTest(manager, context, {
      jsonrpc: "2.0",
      id: 71,
      method: "item/tool/call",
      params: {
        threadId: "provider-thread-native",
        turnId: "turn-native",
        callId: "call-native",
        namespace: null,
        tool: "penkra_exec_command",
        arguments: { command: "apps list" },
      },
    });

    expect(invoke).toHaveBeenCalledWith({
      bearerToken: "thread-token",
      name: "penkra_exec_command",
      arguments: { command: "apps list" },
      originTurnId: "turn-native",
    });
    const response = writeMessage.mock.calls[0]?.[1] as {
      result: {
        contentItems: Array<{ type: string; text?: string; imageUrl?: string }>;
      };
    };
    expect(response.result.contentItems.slice(0, 2)).toEqual([
      { type: "inputText", text: '{"ok":true}' },
      { type: "inputImage", imageUrl: "data:image/png;base64,aW1hZ2U=" },
    ]);
    const resourceItem = response.result.contentItems[2];
    expect(resourceItem?.type).toBe("inputText");
    const resourcePath = resourceItem?.text?.match(/ to (.+)\. This temporary file/)?.[1];
    expect(resourcePath).toBeTruthy();
    expect(readFileSync(resourcePath!, "utf8")).toBe("pdf-bytes");
    await (
      manager as unknown as {
        clearTemporaryResources: (context: unknown, turnId: TurnId) => Promise<void>;
      }
    ).clearTemporaryResources(context, asTurnId("turn-native"));
    expect(() => readFileSync(resourcePath!, "utf8")).toThrow();

    invoke.mockResolvedValueOnce({
      content: [{ type: "text", text: '{"ok":true}' }],
    });
    await handleServerRequestForTest(manager, context, {
      jsonrpc: "2.0",
      id: 72,
      method: "item/tool/call",
      params: {
        threadId: "provider-thread-native",
        callId: "call-without-turn",
        namespace: null,
        tool: "penkra_exec_command",
        arguments: { command: "apps list" },
      },
    });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenLastCalledWith({
      bearerToken: "thread-token",
      name: "penkra_exec_command",
      arguments: { command: "apps list" },
      originTurnId: "turn-native",
    });
    expect(writeMessage.mock.calls[1]?.[1]).toMatchObject({
      result: { success: true },
    });
    // An ID-less arrival while idle cannot acquire the current turn later.
    await handleServerRequestForTest(
      manager,
      context,
      {
        jsonrpc: "2.0",
        id: 79,
        method: "item/tool/call",
        params: {
          threadId: "provider-thread-native",
          namespace: null,
          tool: "penkra_exec_command",
          arguments: { command: "apps list" },
        },
      },
      null,
    );
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(writeMessage).toHaveBeenLastCalledWith(
      context.transport,
      expect.objectContaining({ result: expect.objectContaining({ success: false }) }),
    );
    rmSync(resourceRoot, { recursive: true, force: true });
    expect(writeMessage).toHaveBeenCalledWith(context.transport, {
      id: 71,
      result: {
        contentItems: response.result.contentItems,
        success: true,
      },
    });
  });

  it("registers a native turn before dispatching its first dynamic-tool request", async () => {
    const order: string[] = [];
    const manager = new CodexAppServerManager(undefined, {
      agentGatewayHostTool: {
        acquireSessionLease: () => ({
          connection: { url: "http://unused.invalid/mcp", bearerToken: "thread-token" },
          release: () => undefined,
        }),
        beginTurn: (_threadId, turnId) => order.push(`begin:${turnId}`),
        requireNativeSurface: () => ({
          definitions: [],
          invoke: async () => {
            order.push("invoke");
            return { content: [{ type: "text", text: "ok" }] };
          },
        }),
      },
    });
    const context = {
      transport: {
        key: "test-account",
        cwd: "test-cwd",
        connectionIds: new Set(),
        token: Symbol("test-account"),
        threads: new Set<unknown>(),
        probes: new Map(),
        stopping: false,
      },
      pendingGatewayTurnStart: undefined as { turnId?: TurnId; registered: boolean } | undefined,
      gatewaySessionLease: {
        connection: { url: "http://unused.invalid/mcp", bearerToken: "thread-token" },
        release: () => undefined,
      },
      session: {
        provider: "codex",
        status: "running",
        activeTurnId: undefined,
        threadId: asThreadId("thread-first-tool"),
        runtimeMode: "full-access",
        resumeCursor: { threadId: "provider-thread-native" },
        createdAt: "2026-09-29T00:00:00.000Z",
        updatedAt: "2026-09-29T00:00:00.000Z",
      },
      pendingUserInputs: new Map(),
      collabReceiverTurns: new Map(),
      collabReceiverParents: new Map(),
      reviewTurnIds: new Set(),
      terminalTurnIds: new Set(),
      temporaryResourcePaths: new Map(),
      stopping: false,
    };
    context.transport.threads.add(context);
    vi.spyOn(
      manager as unknown as { emitEvent: (...args: unknown[]) => void },
      "emitEvent",
    ).mockImplementation(() => {});
    vi.spyOn(
      manager as unknown as { writeMessage: (...args: unknown[]) => Promise<void> },
      "writeMessage",
    ).mockResolvedValue(undefined);

    await handleServerRequestForTest(manager, context, {
      jsonrpc: "2.0",
      id: 73,
      method: "item/tool/call",
      params: {
        threadId: "provider-thread-native",
        turnId: "turn-immediate",
        namespace: null,
        tool: "penkra_exec_command",
        arguments: { command: "apps list" },
      },
    });
    expect(order).toEqual([]);
    context.pendingGatewayTurnStart = {
      turnId: asTurnId("turn-dispatched-other"),
      registered: false,
    };
    await handleServerRequestForTest(manager, context, {
      jsonrpc: "2.0",
      id: 76,
      method: "item/tool/call",
      params: {
        threadId: "provider-thread-native",
        turnId: "turn-immediate",
        namespace: null,
        tool: "penkra_exec_command",
        arguments: { command: "apps list" },
      },
    });
    expect(order).toEqual([]);
    context.pendingGatewayTurnStart = { registered: false };
    await handleServerRequestForTest(manager, context, {
      jsonrpc: "2.0",
      id: 74,
      method: "item/tool/call",
      params: {
        threadId: "provider-thread-native",
        turnId: "turn-immediate",
        namespace: null,
        tool: "penkra_exec_command",
        arguments: { command: "apps list" },
      },
    });
    expect(order).toEqual(["begin:turn-immediate", "invoke"]);
    context.terminalTurnIds.add(asTurnId("turn-immediate"));
    await handleServerRequestForTest(manager, context, {
      jsonrpc: "2.0",
      id: 75,
      method: "item/tool/call",
      params: {
        threadId: "provider-thread-native",
        turnId: "turn-immediate",
        namespace: null,
        tool: "penkra_exec_command",
        arguments: { command: "apps list" },
      },
    });
    expect(order).toEqual(["begin:turn-immediate", "invoke"]);
  });
});

function createSendTurnHarness(runtimeMode: "approval-required" | "full-access" = "full-access") {
  const manager = new CodexAppServerManager();
  const context = {
    session: {
      provider: "codex",
      status: "ready",
      threadId: "thread_1",
      runtimeMode,
      model: "gpt-5.3-codex",
      activeTurnId: undefined as string | undefined,
      resumeCursor: { threadId: "thread_1" },
      createdAt: "2026-02-10T00:00:00.000Z",
      updatedAt: "2026-02-10T00:00:00.000Z",
    },
    transport: {
      threads: new Set<unknown>(),
      probes: new Map(),
      account: {
        type: "unknown",
        planType: null,
        sparkEnabled: true,
      },
    },

    pendingUserInputs: new Map(),
    collabReceiverTurns: new Map(),
    collabReceiverParents: new Map(),
    reviewTurnIds: new Set<string>(),
    terminalTurnIds: new Set<string>(),
  };

  context.transport.threads.add(context);
  (manager as unknown as { sessions: Map<string, unknown> }).sessions.set(
    context.session.threadId,
    context,
  );
  const requireSession = vi
    .spyOn(
      manager as unknown as { requireSession: (sessionId: string) => unknown },
      "requireSession",
    )
    .mockReturnValue(context);
  const sendRequest = vi
    .spyOn(
      manager as unknown as {
        sendRequest: (...args: unknown[]) => Promise<unknown>;
      },
      "sendRequest",
    )
    .mockResolvedValue({
      turn: {
        id: "turn_1",
      },
    });
  const updateSession = vi
    .spyOn(manager as unknown as { updateSession: (...args: unknown[]) => void }, "updateSession")
    .mockImplementation(() => {});

  return { manager, context, requireSession, sendRequest, updateSession };
}

describe("Codex native start ordering", () => {
  it.each(["send", "review"])(
    "allows only one native start in flight per session before another %s",
    async (nextKind) => {
      const { manager, sendRequest } = createSendTurnHarness();
      let release!: () => void;
      let entered!: () => void;
      const firstEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const firstResponse = new Promise<unknown>((resolve) => {
        release = () => resolve({ turn: { id: "turn-first" } });
      });
      sendRequest.mockImplementationOnce(() => {
        entered();
        return firstResponse;
      });
      const first = manager.sendTurn({ threadId: asThreadId("thread_1"), input: "first" });
      await firstEntered;
      const second =
        nextKind === "send"
          ? manager.sendTurn({ threadId: asThreadId("thread_1"), input: "second" })
          : manager.startReview({
              threadId: asThreadId("thread_1"),
              target: { type: "uncommittedChanges" },
            });
      await new Promise<void>((resolve) => setImmediate(resolve));
      try {
        expect(sendRequest).toHaveBeenCalledTimes(1);
      } finally {
        release();
        await Promise.all([first, second]);
      }
      expect(sendRequest).toHaveBeenCalledTimes(2);
    },
  );

  it("releases the native start slot after a failed dispatch", async () => {
    const { manager, sendRequest } = createSendTurnHarness();
    sendRequest.mockRejectedValueOnce(new Error("start failed"));
    const results = await Promise.allSettled([
      manager.sendTurn({ threadId: asThreadId("thread_1"), input: "first" }),
      manager.sendTurn({ threadId: asThreadId("thread_1"), input: "second" }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
    expect(sendRequest).toHaveBeenCalledTimes(2);
  });

  it("captures the active turn synchronously at stdio ingress, including an idle arrival", () => {
    const { manager, context, updateSession } = createSendTurnHarness();
    updateSession.mockImplementation((_context, patch) => {
      Object.assign(context.session, patch);
    });
    context.session.status = "running";
    context.session.activeTurnId = "turn-received";
    const requests = vi
      .spyOn(
        manager as unknown as {
          handleServerRequest: (
            context: unknown,
            request: unknown,
            ingressTurnId?: TurnId | null,
          ) => Promise<void>;
        },
        "handleServerRequest",
      )
      .mockResolvedValue();
    const receive = () =>
      (
        manager as unknown as { handleStdoutLine: (context: unknown, line: string) => void }
      ).handleStdoutLine(
        context.transport,
        JSON.stringify({
          jsonrpc: "2.0",
          id: 89,
          method: "item/tool/call",
          params: {
            threadId: "thread_1",
            namespace: null,
            tool: "penkra_exec_command",
            arguments: { command: "apps list" },
          },
        }),
      );
    receive();
    (
      manager as unknown as { handleStdoutLine: (context: unknown, line: string) => void }
    ).handleStdoutLine(
      context.transport,
      JSON.stringify({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { threadId: "thread_1", turn: { id: "turn-received", status: "completed" } },
      }),
    );
    receive();
    context.session.activeTurnId = "turn-later";
    expect(requests.mock.calls[0]?.[2]).toBe("turn-received");
    expect(requests.mock.calls[1]?.[2]).toBeNull();
  });
});

function createThreadControlHarness() {
  const manager = new CodexAppServerManager();
  const context = {
    transport: {
      key: "test-account",
      cwd: "test-cwd",
      connectionIds: new Set(),
      token: Symbol("test-account"),
      threads: new Set<unknown>(),
      probes: new Map(),
      stopping: false,
    },
    lifecycleGeneration: "generation-request-a",
    session: {
      provider: "codex",
      status: "ready",
      threadId: "thread_1",
      runtimeMode: "full-access",
      model: "gpt-5.3-codex",
      activeTurnId: undefined as string | undefined,
      resumeCursor: { threadId: "thread_1" },
      createdAt: "2026-02-10T00:00:00.000Z",
      updatedAt: "2026-02-10T00:00:00.000Z",
    },
    pendingUserInputs: new Map(),
    collabReceiverTurns: new Map(),
    collabReceiverParents: new Map(),
    reviewTurnIds: new Set<string>(),
    terminalTurnIds: new Set<string>(),
  };
  context.transport.threads.add(context);

  (manager as unknown as { sessions: Map<string, unknown> }).sessions.set(
    context.session.threadId,
    context,
  );
  const requireSession = vi
    .spyOn(
      manager as unknown as { requireSession: (sessionId: string) => unknown },
      "requireSession",
    )
    .mockReturnValue(context);
  const sendRequest = vi.spyOn(
    manager as unknown as {
      sendRequest: (...args: unknown[]) => Promise<unknown>;
    },
    "sendRequest",
  );
  const updateSession = vi
    .spyOn(manager as unknown as { updateSession: (...args: unknown[]) => void }, "updateSession")
    .mockImplementation(() => {});
  const emitEvent = vi
    .spyOn(manager as unknown as { emitEvent: (...args: unknown[]) => void }, "emitEvent")
    .mockImplementation(() => {});

  return {
    manager,
    context,
    requireSession,
    sendRequest,
    updateSession,
    emitEvent,
  };
}

function createPendingUserInputHarness() {
  const manager = new CodexAppServerManager();
  const context = {
    transport: {
      key: "test-account",
      cwd: "test-cwd",
      connectionIds: new Set(),
      token: Symbol("test-account"),
      threads: new Set<unknown>(),
      probes: new Map(),
      stopping: false,
    },
    session: {
      provider: "codex",
      status: "ready",
      threadId: "thread_1",
      runtimeMode: "full-access",
      model: "gpt-5.3-codex",
      activeTurnId: undefined as string | undefined,
      resumeCursor: { threadId: "thread_1" },
      createdAt: "2026-02-10T00:00:00.000Z",
      updatedAt: "2026-02-10T00:00:00.000Z",
    },
    pendingUserInputs: new Map([
      [
        "req-user-input-1",
        {
          requestId: "req-user-input-1",
          jsonRpcId: 42,
          threadId: asThreadId("thread_1"),
        },
      ],
    ]),
    collabReceiverTurns: new Map(),
    collabReceiverParents: new Map(),
    reviewTurnIds: new Set<string>(),
    terminalTurnIds: new Set<string>(),
  };
  context.transport.threads.add(context);

  const requireSession = vi
    .spyOn(
      manager as unknown as { requireSession: (sessionId: string) => unknown },
      "requireSession",
    )
    .mockReturnValue(context);
  const writeMessage = vi
    .spyOn(
      manager as unknown as {
        writeMessage: (...args: unknown[]) => Promise<void>;
      },
      "writeMessage",
    )
    .mockResolvedValue(undefined);
  const emitEvent = vi
    .spyOn(manager as unknown as { emitEvent: (...args: unknown[]) => void }, "emitEvent")
    .mockImplementation(() => {});

  return { manager, context, requireSession, writeMessage, emitEvent };
}

function createCollabNotificationHarness() {
  const manager = new CodexAppServerManager();
  const context = {
    transport: {
      key: "test-account",
      cwd: "test-cwd",
      connectionIds: new Set(),
      token: Symbol("test-account"),
      threads: new Set<unknown>(),
      probes: new Map(),
      stopping: false,
      account: {
        type: "unknown",
        planType: null,
        sparkEnabled: true,
      },
      pending: new Map(),
      nextRequestId: 1,
    },
    session: {
      provider: "codex",
      status: "running",
      threadId: asThreadId("thread_1"),
      runtimeMode: "full-access",
      model: "gpt-5.3-codex",
      activeTurnId: "turn_parent",
      resumeCursor: { threadId: "provider_parent" },
      createdAt: "2026-02-10T00:00:00.000Z",
      updatedAt: "2026-02-10T00:00:00.000Z",
    },
    pendingUserInputs: new Map(),
    collabReceiverTurns: new Map<string, string>(),
    collabReceiverParents: new Map<string, string>(),
    reviewTurnIds: new Set<string>(),
    terminalTurnIds: new Set<string>(),
    stopping: false,
  };
  context.transport.threads.add(context);

  const emitEvent = vi
    .spyOn(manager as unknown as { emitEvent: (...args: unknown[]) => void }, "emitEvent")
    .mockImplementation(() => {});
  const updateSession = vi
    .spyOn(manager as unknown as { updateSession: (...args: unknown[]) => void }, "updateSession")
    .mockImplementation(() => {});
  const requireSession = vi
    .spyOn(
      manager as unknown as { requireSession: (threadId: ThreadId) => unknown },
      "requireSession",
    )
    .mockReturnValue(context);
  const writeMessage = vi
    .spyOn(
      manager as unknown as {
        writeMessage: (...args: unknown[]) => Promise<void>;
      },
      "writeMessage",
    )
    .mockResolvedValue(undefined);

  return {
    manager,
    context,
    emitEvent,
    updateSession,
    requireSession,
    writeMessage,
  };
}

function handleServerNotificationForTest(
  manager: CodexAppServerManager,
  context: unknown,
  notification: Record<string, unknown>,
): void {
  (
    manager as unknown as {
      handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
    }
  ).handleServerNotification(context, notification);
}

async function handleServerRequestForTest(
  manager: CodexAppServerManager,
  context: unknown,
  request: Record<string, unknown>,
  ingressTurnId: string | null = (context as { session: { activeTurnId?: string } }).session
    .activeTurnId ?? null,
): Promise<void> {
  await (
    manager as unknown as {
      handleServerRequest: (
        context: unknown,
        request: Record<string, unknown>,
        ingressTurnId: string | null,
      ) => Promise<void>;
    }
  ).handleServerRequest(context, request, ingressTurnId);
}

function createProcessOutputHarness() {
  const manager = new CodexAppServerManager();
  const context = {
    transport: {
      key: "test-account",
      cwd: "test-cwd",
      connectionIds: new Set(),
      token: Symbol("test-account"),
      threads: new Set<unknown>(),
      probes: new Map(),
      stopping: false,
    },
    session: {
      provider: "codex",
      status: "running",
      threadId: asThreadId("thread_1"),
      runtimeMode: "full-access",
      model: "gpt-5.3-codex",
      createdAt: "2026-02-10T00:00:00.000Z",
      updatedAt: "2026-02-10T00:00:00.000Z",
    },
    reviewTurnIds: new Set<string>(),
    terminalTurnIds: new Set<string>(),
    stopping: false,
  };
  context.transport.threads.add(context);
  const emitEvent = vi
    .spyOn(manager as unknown as { emitEvent: (...args: unknown[]) => void }, "emitEvent")
    .mockImplementation(() => {});

  return { manager, context, emitEvent };
}

describe("Codex app-server teardown", () => {
  it("keeps a live process routable when only the last turn status is error", () => {
    class FakeCodexChild extends EventEmitter {
      readonly pid = 5050;
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;
      killed = false;
      readonly stdin = new PassThrough();
      readonly stdout = new PassThrough();
      readonly stderr = new PassThrough();
    }
    const child = new FakeCodexChild();
    const manager = new CodexAppServerManager();
    const threadId = asThreadId("thread-codex-failed-turn");
    const context = {
      transport: {
        key: "test-account",
        cwd: "test-cwd",
        connectionIds: new Set(),
        token: Symbol("test-account"),
        threads: new Set<unknown>(),
        probes: new Map(),
        stopping: false,
        account: { type: "unknown", planType: null, sparkEnabled: true },
        child,
        stdoutFramer: new CodexJsonlFramer(),
        stdinWriter: new CodexJsonlWriter(child.stdin),
        pending: new Map(),
        stderrLineFramer: new CodexStderrLineFramer(),
        stderrRecordFramer: new CodexStderrRecordFramer(),
        nextRequestId: 1,
      },
      session: {
        provider: "codex",
        status: "error",
        threadId,
        runtimeMode: "full-access",
        lastError: "Turn failed",
        createdAt: "2026-07-14T00:00:00.000Z",
        updatedAt: "2026-07-14T00:00:00.000Z",
      },
      pendingUserInputs: new Map(),
      collabReceiverTurns: new Map(),
      collabReceiverParents: new Map(),
      reviewTurnIds: new Set(),
      terminalTurnIds: new Set(),
      stopping: false,
    };
    context.transport.threads.add(context);
    const internals = manager as unknown as {
      sessions: Map<ThreadId, unknown>;
      requireSession: (threadId: ThreadId) => unknown;
    };
    internals.sessions.set(threadId, context);

    expect(manager.hasSession(threadId)).toBe(true);
    expect(manager.listSessions()).toEqual([
      expect.objectContaining({ threadId, status: "error" }),
    ]);
    expect(internals.requireSession(threadId)).toBe(context);

    child.stdin.end();

    expect(manager.hasSession(threadId)).toBe(false);
    expect(manager.listSessions()).toEqual([]);
    expect(() => internals.requireSession(threadId)).toThrow("Session is closed");
  });

  it("makes the session unroutable immediately while stop awaits exit proof", async () => {
    class FakeCodexChild extends EventEmitter {
      readonly pid = 5151;
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;
      readonly stdin = new PassThrough();
      readonly stdout = new PassThrough();
      readonly stderr = new PassThrough();
    }
    const child = new FakeCodexChild();
    let exitProven = false;
    let enteredTeardown!: () => void;
    const teardownEntered = new Promise<void>((resolve) => {
      enteredTeardown = resolve;
    });
    const teardownProcessTree = vi.fn(
      async (input: { readonly rootPid: number; readonly rootExited: Promise<unknown> }) => {
        enteredTeardown();
        expect(input.rootPid).toBe(5151);
        await input.rootExited;
        exitProven = true;
        return { escalated: false as const, signalErrors: [] };
      },
    );
    const manager = new CodexAppServerManager(undefined, {
      teardownProcessTree,
    });
    const threadId = asThreadId("thread-codex-exit-proof");
    const revokeSessionToken = vi.fn();
    const gatewaySessionLease = acquireAgentGatewaySessionLease(
      {
        connectionForThread: () => ({
          url: "http://127.0.0.1:48123/mcp",
          bearerToken: "gateway-token",
        }),
        revokeSessionToken,
      },
      threadId,
      "codex",
    );
    const context = {
      transport: {
        key: "test-account",
        cwd: "test-cwd",
        connectionIds: new Set(),
        token: Symbol("test-account"),
        threads: new Set<unknown>(),
        probes: new Map(),
        stopping: false,
        account: { type: "unknown", planType: null, sparkEnabled: true },
        child,
        stdoutFramer: new CodexJsonlFramer(),
        stdinWriter: new CodexJsonlWriter(child.stdin),
        pending: new Map(),
        stderrLineFramer: new CodexStderrLineFramer(),
        stderrRecordFramer: new CodexStderrRecordFramer(),
        nextRequestId: 1,
      },
      gatewaySessionLease,
      session: {
        provider: "codex",
        status: "ready",
        threadId,
        runtimeMode: "full-access",
        createdAt: "2026-07-14T00:00:00.000Z",
        updatedAt: "2026-07-14T00:00:00.000Z",
      },
      pendingUserInputs: new Map(),
      collabReceiverTurns: new Map(),
      collabReceiverParents: new Map(),
      reviewTurnIds: new Set(),
      terminalTurnIds: new Set(),
      stopping: false,
    };
    context.transport.threads.add(context);
    (
      manager as unknown as {
        sessions: Map<ThreadId, unknown>;
      }
    ).sessions.set(threadId, context);

    const stopping = closeProcessForTest(manager, context.transport);
    await teardownEntered;
    expect(revokeSessionToken).toHaveBeenCalledOnce();
    expect(teardownProcessTree).toHaveBeenCalledTimes(1);
    // Unroutable immediately: follow-ups must fall through to thread/resume
    // instead of writing into the dying process's stdin.
    expect(manager.hasSession(threadId)).toBe(false);
    expect(exitProven).toBe(false);

    child.exitCode = 0;
    child.emit("exit", 0, null);
    await stopping;
    expect(revokeSessionToken).toHaveBeenCalledOnce();
    expect(exitProven).toBe(true);
    expect(manager.hasSession(threadId)).toBe(false);
  });

  it("releases the session lease once when the app-server exits spontaneously", () => {
    class FakeCodexChild extends EventEmitter {
      readonly pid = 5252;
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;
      readonly stdin = new PassThrough();
      readonly stdout = new PassThrough();
      readonly stderr = new PassThrough();
    }
    const child = new FakeCodexChild();
    const manager = new CodexAppServerManager();
    const threadId = asThreadId("thread-codex-spontaneous-exit");
    const revokeSessionToken = vi.fn();
    const gatewaySessionLease = acquireAgentGatewaySessionLease(
      {
        connectionForThread: () => ({
          url: "http://127.0.0.1:48123/mcp",
          bearerToken: "gateway-token",
        }),
        revokeSessionToken,
      },
      threadId,
      "codex",
    );
    const context = {
      transport: {
        key: "test-account",
        cwd: "test-cwd",
        connectionIds: new Set(),
        token: Symbol("test-account"),
        threads: new Set<unknown>(),
        probes: new Map(),
        stopping: false,
        account: { type: "unknown", planType: null, sparkEnabled: true },
        child,
        stdoutFramer: new CodexJsonlFramer(),
        stdinWriter: new CodexJsonlWriter(child.stdin),
        pending: new Map(),
        stderrLineFramer: new CodexStderrLineFramer(),
        stderrRecordFramer: new CodexStderrRecordFramer(),
        nextRequestId: 1,
      },
      gatewaySessionLease,
      session: {
        provider: "codex",
        status: "ready",
        threadId,
        runtimeMode: "full-access",
        createdAt: "2026-07-14T00:00:00.000Z",
        updatedAt: "2026-07-14T00:00:00.000Z",
      },
      pendingUserInputs: new Map(),
      collabReceiverTurns: new Map(),
      collabReceiverParents: new Map(),
      reviewTurnIds: new Set(),
      terminalTurnIds: new Set(),
      stopping: false,
    };
    context.transport.threads.add(context);
    const internals = manager as unknown as {
      sessions: Map<ThreadId, unknown>;
      attachProcessListeners: (context: unknown) => void;
    };
    internals.sessions.set(threadId, context);
    internals.attachProcessListeners(context.transport);

    child.emit("exit", 1, null);
    child.emit("exit", 1, null);

    expect(revokeSessionToken).toHaveBeenCalledOnce();
    expect(manager.hasSession(threadId)).toBe(false);
  });

  it("preserves redacted stderr and process metadata when app-server exits", () => {
    class FakeCodexChild extends EventEmitter {
      readonly pid = 5353;
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;
      killed = false;
      readonly stdin = new PassThrough();
      readonly stdout = new PassThrough();
      readonly stderr = new PassThrough();
    }
    const child = new FakeCodexChild();
    const manager = new CodexAppServerManager();
    const threadId = asThreadId("thread-codex-diagnostic-exit");
    const reject = vi.fn();
    const timeout = setTimeout(() => undefined, 60_000);
    const context = {
      transport: {
        key: "test-account",
        cwd: "/Users/test/Desktop/protected-workspace",
        connectionIds: new Set(),
        token: Symbol("test-account"),
        threads: new Set<unknown>(),
        probes: new Map(),
        stopping: false,
        account: { type: "unknown", planType: null, sparkEnabled: true },
        child,
        binaryPath: "/managed/codex",
        stdoutFramer: new CodexJsonlFramer(),
        stdinWriter: new CodexJsonlWriter(child.stdin),
        pending: new Map([
          [
            "1",
            {
              method: "initialize",
              timeout,
              resolve: vi.fn(),
              reject,
            },
          ],
        ]),
        mcpStartupStatuses: new Map(),
        reportedMcpStartupFailures: new Set(),
        stderrLineFramer: new CodexStderrLineFramer(),
        stderrRecordFramer: new CodexStderrRecordFramer(),
        nextRequestId: 2,
        lastRequestMethod: "initialize",
      },
      session: {
        provider: "codex",
        status: "connecting",
        threadId,
        runtimeMode: "full-access",
        cwd: "/Users/test/Desktop/protected-workspace",
        createdAt: "2026-07-14T00:00:00.000Z",
        updatedAt: "2026-07-14T00:00:00.000Z",
      },
      pendingUserInputs: new Map(),
      collabReceiverTurns: new Map(),
      collabReceiverParents: new Map(),
      reviewTurnIds: new Set(),
      terminalTurnIds: new Set(),
      stopping: false,
    };
    context.transport.threads.add(context);
    const internals = manager as unknown as {
      sessions: Map<ThreadId, unknown>;
      attachProcessListeners: (context: unknown) => void;
    };
    internals.sessions.set(threadId, context);
    internals.attachProcessListeners(context.transport);

    child.stderr.write("authorization: bearer-secret-");
    child.stderr.write("value-that-must-not-leak\nfatal: Operation not permitted (os error 1)\n");
    child.exitCode = 1;
    child.emit("exit", 1, null);

    expect(reject).toHaveBeenCalledOnce();
    const error = reject.mock.calls[0]?.[0] as Error;
    expect(error.message).toContain("reason=process-exit");
    expect(error.message).toContain("pid=5353");
    expect(error.message).toContain("code=1");
    expect(error.message).toContain("request=initialize");
    expect(error.message).toContain("binary=/managed/codex");
    expect(error.message).toContain("cwd=/Users/test/Desktop/protected-workspace");
    expect(error.message).toContain("fatal: Operation not permitted (os error 1)");
    expect(error.message).toContain("authorization: [redacted]");
    expect(error.message).not.toContain("bearer-secret-value-that-must-not-leak");
  });

  it("keeps response correlation after compacting an oversized file-change notification", () => {
    class FakeCodexChild extends EventEmitter {
      readonly pid = 5400;
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;
      killed = false;
      readonly stdin = new PassThrough();
      readonly stdout = new PassThrough();
      readonly stderr = new PassThrough();
    }
    const child = new FakeCodexChild();
    const manager = new CodexAppServerManager();
    const threadId = asThreadId("thread-codex-oversized-file-change");
    const resolve = vi.fn();
    const reject = vi.fn();
    const timeout = setTimeout(() => undefined, 60_000);
    const context = {
      transport: {
        key: "test-account",
        cwd: "test-cwd",
        connectionIds: new Set(),
        token: Symbol("test-account"),
        threads: new Set<unknown>(),
        probes: new Map(),
        stopping: false,
        account: { type: "unknown", planType: null, sparkEnabled: true },
        child,
        stdoutFramer: new CodexJsonlFramer(1_024),
        stdinWriter: new CodexJsonlWriter(child.stdin),
        pending: new Map([
          [
            "7",
            {
              method: "turn/steer",
              timeout,
              resolve,
              reject,
            },
          ],
        ]),
        mcpStartupStatuses: new Map(),
        reportedMcpStartupFailures: new Set(),
        stderrLineFramer: new CodexStderrLineFramer(),
        stderrRecordFramer: new CodexStderrRecordFramer(),
        nextRequestId: 8,
        lastRequestMethod: "turn/steer",
      },
      session: {
        provider: "codex",
        status: "running",
        threadId,
        activeTurnId: asTurnId("parent-turn"),
        resumeCursor: { threadId: "parent-provider-thread" },
        runtimeMode: "full-access",
        createdAt: "2026-09-15T00:00:00.000Z",
        updatedAt: "2026-09-15T00:00:00.000Z",
      },
      pendingUserInputs: new Map(),
      collabReceiverTurns: new Map([["child-provider-thread", asTurnId("parent-turn")]]),
      collabReceiverParents: new Map([["child-provider-thread", "parent-provider-thread"]]),
      reviewTurnIds: new Set(),
      terminalTurnIds: new Set(),
      stopping: false,
    };
    context.transport.threads.add(context);
    const events: Array<{
      readonly method?: string;
      readonly payload?: unknown;
    }> = [];
    manager.on("event", (event) => events.push(event));
    const internals = manager as unknown as {
      sessions: Map<ThreadId, unknown>;
      attachProcessListeners: (context: unknown) => void;
    };
    internals.sessions.set(threadId, context);
    internals.attachProcessListeners(context.transport);

    child.stdout.write(
      `${JSON.stringify({
        method: "item/started",
        params: {
          item: {
            type: "fileChange",
            id: "patch-1",
            changes: [{ path: "generated.js", kind: "delete", diff: "x".repeat(2_048) }],
            status: "inProgress",
          },
          threadId: "child-provider-thread",
          turnId: "child-turn",
        },
      })}\n${JSON.stringify({
        method: "codex/event/item_completed",
        params: {
          id: "child-turn",
          msg: {
            type: "item_completed",
            thread_id: "child-provider-thread",
            turn_id: "child-turn",
            item: {
              type: "FileChange",
              id: "patch-legacy",
              changes: {
                "generated.js": { type: "delete", content: "x".repeat(2_048) },
              },
            },
          },
        },
      })}\n${JSON.stringify({
        method: "item/completed",
        params: {
          item: {
            type: "fileChange",
            id: "patch-1",
            changes: [{ path: "generated.js", kind: "delete", diff: "x".repeat(2_048) }],
            status: "failed",
          },
          threadId: "child-provider-thread",
          turnId: "child-turn",
          completedAtMs: 123,
        },
      })}\n${JSON.stringify({ id: 7, result: { turnId: "provider-turn" } })}\n`,
    );

    expect(reject).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledWith({ turnId: "provider-turn" });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "protocol/oversizedNotificationCompacted",
          payload: expect.objectContaining({
            sourceMethod: "item/started",
            maxBytes: 1_024,
          }),
        }),
        expect.objectContaining({
          method: "protocol/oversizedNotificationCompacted",
          payload: expect.objectContaining({
            sourceMethod: "codex/event/item_completed",
            maxBytes: 1_024,
          }),
        }),
        expect.objectContaining({
          method: "protocol/oversizedNotificationCompacted",
          payload: expect.objectContaining({
            sourceMethod: "item/completed",
            maxBytes: 1_024,
          }),
        }),
        expect.objectContaining({
          method: "item/started",
          turnId: "child-turn",
          parentTurnId: "parent-turn",
          providerThreadId: "child-provider-thread",
          providerParentThreadId: "parent-provider-thread",
          payload: expect.objectContaining({
            item: expect.objectContaining({
              type: "fileChange",
              id: "patch-1",
              changes: [],
              status: "inProgress",
            }),
          }),
        }),
        expect.objectContaining({
          method: "item/completed",
          turnId: "child-turn",
          parentTurnId: "parent-turn",
          providerThreadId: "child-provider-thread",
          providerParentThreadId: "parent-provider-thread",
          payload: expect.objectContaining({
            item: expect.objectContaining({
              type: "fileChange",
              id: "patch-1",
              changes: [],
              status: "failed",
            }),
          }),
        }),
      ]),
    );
    expect(manager.hasSession(threadId)).toBe(true);
    child.stdin.end();
  });

  it("rejects the pending request with stderr when stdout closes first", async () => {
    class FakeCodexChild extends EventEmitter {
      readonly pid = 5454;
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;
      killed = false;
      readonly stdin = new PassThrough();
      readonly stdout = new PassThrough();
      readonly stderr = new PassThrough();
    }
    const child = new FakeCodexChild();
    const terminate = vi.fn(async () => {
      child.killed = true;
      return { escalated: false, signalErrors: [] };
    });
    const manager = new CodexAppServerManager(undefined, { teardownProcessTree: terminate });
    const threadId = asThreadId("thread-codex-diagnostic-stdout-end");
    const reject = vi.fn();
    const timeout = setTimeout(() => undefined, 60_000);
    const context = {
      transport: {
        key: "test-account",
        cwd: "/Users/test/Desktop/protected-workspace",
        connectionIds: new Set(),
        token: Symbol("test-account"),
        threads: new Set<unknown>(),
        probes: new Map(),
        stopping: false,
        protocolClosed: false,
        account: { type: "unknown", planType: null, sparkEnabled: true },
        child,
        binaryPath: "/managed/codex",
        stdoutFramer: new CodexJsonlFramer(),
        stdinWriter: new CodexJsonlWriter(child.stdin),
        pending: new Map([
          [
            "1",
            {
              method: "initialize",
              timeout,
              resolve: vi.fn(),
              reject,
            },
          ],
        ]),
        mcpStartupStatuses: new Map(),
        reportedMcpStartupFailures: new Set(),
        stderrLineFramer: new CodexStderrLineFramer(),
        stderrRecordFramer: new CodexStderrRecordFramer(),
        nextRequestId: 2,
        lastRequestMethod: "initialize",
      },
      session: {
        provider: "codex",
        status: "connecting",
        threadId,
        runtimeMode: "full-access",
        cwd: "/Users/test/Desktop/protected-workspace",
        createdAt: "2026-07-14T00:00:00.000Z",
        updatedAt: "2026-07-14T00:00:00.000Z",
      },
      pendingUserInputs: new Map(),
      collabReceiverTurns: new Map(),
      collabReceiverParents: new Map(),
      reviewTurnIds: new Set(),
      terminalTurnIds: new Set(),
      stopping: false,
    };
    context.transport.threads.add(context);
    const internals = manager as unknown as {
      sessions: Map<ThreadId, unknown>;
      attachProcessListeners: (context: unknown) => void;
    };
    internals.sessions.set(threadId, context);
    internals.attachProcessListeners(context.transport);

    child.stdout.emit("end");
    expect(child.killed).toBe(true);
    expect(terminate).toHaveBeenCalledOnce();
    expect(reject).not.toHaveBeenCalled();
    child.stderr.write("fatal: helper launch failed: Operation not permitted (os error 1)\n");
    child.exitCode = 1;
    child.emit("exit", 1, null);
    expect(reject).not.toHaveBeenCalled();
    child.stderr.emit("end");
    child.emit("close", 1, null);
    child.emit("close", 1, null);

    expect(reject).toHaveBeenCalledOnce();
    const error = reject.mock.calls[0]?.[0] as Error;
    expect(error.message).toContain("stdout closed before process shutdown");
    expect(error.message).toContain("request=initialize");
    expect(error.message).toContain("code=1");
    expect(error.message).toContain("helper launch failed: Operation not permitted");
    expect(error.message).not.toContain("Session stopped before request completed");
  });
});

describe("buildCodexProcessEnv", () => {
  it("hydrates the active custom provider env_key from the effective CODEX_HOME", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "penkra-codex-env-"));
    try {
      writeFileSync(
        path.join(tempDir, "config.toml"),
        [
          'model_provider = "my-company-proxy"',
          "",
          '[model_providers."my-company-proxy"]',
          'env_key = "MY_COMPANY_PROXY_KEY"',
        ].join("\n"),
        "utf8",
      );

      const readEnvironment = vi.fn(() => ({
        PATH: "/opt/homebrew/bin:/usr/bin",
        SSH_AUTH_SOCK: "/tmp/ssh.sock",
        MY_COMPANY_PROXY_KEY: "proxy-secret",
      }));

      const env = await buildCodexProcessEnv({
        env: {
          SHELL: "/bin/zsh",
          PATH: "/usr/bin",
        },
        homePath: tempDir,
        platform: "darwin",
        readEnvironment,
      });

      expect(readEnvironment).toHaveBeenCalledWith("/bin/zsh", [
        "PATH",
        "SSH_AUTH_SOCK",
        "MY_COMPANY_PROXY_KEY",
      ]);
      expect(env.CODEX_HOME).toContain("codex-home-overlay");
      expect(env.MY_COMPANY_PROXY_KEY).toBe("proxy-secret");
      expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not read shell env when the provider key is already present", async () => {
    const readEnvironment = vi.fn();

    const env = await buildCodexProcessEnv({
      env: {
        SHELL: "/bin/zsh",
        PATH: "/usr/bin",
        CODEX_HOME: "/tmp/.codex",
        AZURE_OPENAI_API_KEY: "existing-secret",
      },
      platform: "darwin",
      readEnvironment,
    });

    expect(readEnvironment).not.toHaveBeenCalled();
    expect(env.AZURE_OPENAI_API_KEY).toBe("existing-secret");
  });

  it("preserves provider-native plugins inside Penkra's Codex overlay", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "penkra-codex-env-"));
    const runtimeHome = mkdtempSync(path.join(os.tmpdir(), "penkra-runtime-home-"));
    try {
      writeFileSync(
        path.join(tempDir, "config.toml"),
        [
          '[plugins."github@openai-curated"]',
          "enabled = true",
          "",
          '[plugins."historical-plugin@local"]',
          "enabled = true",
          "",
          '[plugins."browser@openai-bundled"]',
          "enabled = true",
        ].join("\n"),
        "utf8",
      );

      const env = await buildCodexProcessEnv({
        env: { PENKRA_HOME: runtimeHome },
        homePath: tempDir,
        platform: "darwin",
      });

      expect(env.CODEX_HOME).toBe(path.join(runtimeHome, "codex-home-overlay"));
      const codexHome = env.CODEX_HOME;
      if (typeof codexHome !== "string") {
        throw new Error("Expected CODEX_HOME to be set.");
      }
      const overlayConfig = readFileSync(path.join(codexHome, "config.toml"), "utf8");
      expect(overlayConfig).toContain('[plugins."github@openai-curated"]\nenabled = true');
      expect(overlayConfig).toContain('[plugins."historical-plugin@local"]\nenabled = true');
      expect(overlayConfig).toContain('[plugins."browser@openai-bundled"]\nenabled = true');
      const sourceConfig = readFileSync(path.join(tempDir, "config.toml"), "utf8");
      expect(sourceConfig).toContain('[plugins."github@openai-curated"]\nenabled = true');
      expect(sourceConfig).toContain('[plugins."historical-plugin@local"]\nenabled = true');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it("preserves both user-enabled Computer Use routes", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "penkra-codex-env-"));
    const runtimeHome = mkdtempSync(path.join(os.tmpdir(), "penkra-runtime-home-"));
    try {
      writeFileSync(
        path.join(tempDir, "config.toml"),
        [
          '[plugins."computer-use@openai-bundled"]',
          "enabled = true",
          "",
          '[plugins."computer-use@openai-bundled".mcp_servers."computer-use"]',
          "enabled = true",
          "",
          "[mcp_servers.node_repl]",
          'command = "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl"',
          "",
          "[mcp_servers.node_repl.env]",
          'SKY_CUA_SERVICE_PATH = "/Users/test/.codex/computer-use/Codex Computer Use.app"',
          "",
          "[mcp_servers.untrusted]",
          'command = "untrusted-mcp"',
        ].join("\n"),
        "utf8",
      );

      const env = await buildCodexProcessEnv({
        env: { PENKRA_HOME: runtimeHome },
        homePath: tempDir,
        platform: "darwin",
      });

      const codexHome = env.CODEX_HOME;
      if (typeof codexHome !== "string") {
        throw new Error("Expected CODEX_HOME to be set.");
      }
      const overlayConfig = readFileSync(path.join(codexHome, "config.toml"), "utf8");
      expect(overlayConfig).toContain("[mcp_servers.node_repl]");
      expect(overlayConfig).toContain("[mcp_servers.node_repl.env]");
      expect(overlayConfig).toContain("[mcp_servers.untrusted]");
      expect(overlayConfig).toContain(
        '[plugins."computer-use@openai-bundled".mcp_servers."computer-use"]\nenabled = true',
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it("repairs stale real files in Penkra's Codex home overlay", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "penkra-codex-env-"));
    const runtimeHome = mkdtempSync(path.join(os.tmpdir(), "penkra-runtime-home-"));
    try {
      const sourceMemoryPath = path.join(tempDir, "memories_1.sqlite");
      writeFileSync(path.join(tempDir, "config.toml"), 'model = "gpt-5.5"', "utf8");
      writeFileSync(sourceMemoryPath, "fresh-source-db", "utf8");

      const overlayHome = path.join(runtimeHome, "codex-home-overlay");
      const overlayMemoryPath = path.join(overlayHome, "memories_1.sqlite");
      mkdirSync(overlayHome, { recursive: true });
      writeFileSync(overlayMemoryPath, "stale-overlay-db", "utf8");

      const env = await buildCodexProcessEnv({
        env: { PENKRA_HOME: runtimeHome },
        homePath: tempDir,
        platform: "darwin",
      });

      expect(env.CODEX_HOME).toBe(overlayHome);
      expect(lstatSync(overlayMemoryPath).isSymbolicLink()).toBe(true);
      expect(readlinkSync(overlayMemoryPath)).toBe(sourceMemoryPath);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it("repairs stale auth.json files in Penkra's Codex home overlay", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "penkra-codex-env-"));
    const runtimeHome = mkdtempSync(path.join(os.tmpdir(), "penkra-runtime-home-"));
    try {
      const sourceAuthPath = path.join(tempDir, "auth.json");
      writeFileSync(path.join(tempDir, "config.toml"), 'model = "gpt-5.5"', "utf8");
      writeFileSync(sourceAuthPath, '{"tokens":{"access_token":"fresh"}}', "utf8");

      const overlayHome = path.join(runtimeHome, "codex-home-overlay");
      const overlayAuthPath = path.join(overlayHome, "auth.json");
      mkdirSync(overlayHome, { recursive: true });
      writeFileSync(overlayAuthPath, '{"tokens":{"access_token":"stale"}}', "utf8");

      const env = await buildCodexProcessEnv({
        env: { PENKRA_HOME: runtimeHome },
        homePath: tempDir,
        platform: "darwin",
      });

      expect(env.CODEX_HOME).toBe(overlayHome);
      expect(lstatSync(overlayAuthPath).isSymbolicLink()).toBe(true);
      expect(readlinkSync(overlayAuthPath)).toBe(sourceAuthPath);
      expect(readFileSync(overlayAuthPath, "utf8")).toContain("fresh");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it("preserves real generated image directories in Penkra's Codex home overlay", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "penkra-codex-env-"));
    const runtimeHome = mkdtempSync(path.join(os.tmpdir(), "penkra-runtime-home-"));
    try {
      writeFileSync(path.join(tempDir, "config.toml"), 'model = "gpt-5.5"', "utf8");
      const sourceGeneratedImagesDir = path.join(tempDir, "generated_images");
      mkdirSync(sourceGeneratedImagesDir, { recursive: true });
      writeFileSync(path.join(sourceGeneratedImagesDir, "source.png"), "source-image", "utf8");

      const overlayHome = path.join(runtimeHome, "codex-home-overlay");
      const overlayGeneratedImagesDir = path.join(overlayHome, "generated_images");
      mkdirSync(overlayGeneratedImagesDir, { recursive: true });
      const overlayImagePath = path.join(overlayGeneratedImagesDir, "overlay.png");
      writeFileSync(overlayImagePath, "overlay-image", "utf8");

      const env = await buildCodexProcessEnv({
        env: { PENKRA_HOME: runtimeHome },
        homePath: tempDir,
        platform: "darwin",
      });

      expect(env.CODEX_HOME).toBe(overlayHome);
      expect(lstatSync(overlayGeneratedImagesDir).isDirectory()).toBe(true);
      expect(readFileSync(overlayImagePath, "utf8")).toBe("overlay-image");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(runtimeHome, { recursive: true, force: true });
    }
  });
});

describe("startSession", () => {
  it("removes an in-flight startup request immediately when startup is cancelled", async () => {
    const manager = new CodexAppServerManager();
    const controller = new AbortController();
    const context = {
      child: { pid: 42 },
      nextRequestId: 1,
      pending: new Map(),
      stdinWriter: { write: vi.fn().mockResolvedValue(undefined) },
    };

    const request = (
      manager as unknown as {
        sendRequest: (
          context: unknown,
          ownerThreadId: ThreadId | null,
          method: string,
          params: unknown,
          timeoutMs: number,
          signal: AbortSignal,
        ) => Promise<unknown>;
      }
    ).sendRequest(context, null, "thread/resume", {}, 10_000, controller.signal);
    await Promise.resolve();
    expect(context.pending.size).toBe(1);

    controller.abort();

    await expect(request).rejects.toThrow(
      "Cancelled thread/resume because Codex session startup was interrupted.",
    );
    expect(context.pending.size).toBe(0);
  });

  it("propagates Codex resume failure without issuing a replacement request", async () => {
    const resumeError = new Error("thread/resume failed: thread not found");
    const request = vi.fn().mockRejectedValue(resumeError);

    await expect(
      resumeCodexThreadWithoutHistoryReplay({
        threadId: "missing-provider-thread",
        sessionOverrides: { cwd: "/workspace" },
        request,
      }),
    ).rejects.toBe(resumeError);

    expect(request).toHaveBeenCalledOnce();
  });
});

describe("sendTurn", () => {
  it.each([
    ["failed", "error"],
    ["completed", "ready"],
    ["interrupted", "ready"],
  ] as const)(
    "settles a terminal %s turn/start result through turn/completed",
    async (status, sessionStatus) => {
      const { manager, context, sendRequest, updateSession } = createSendTurnHarness();
      const events: unknown[] = [];
      manager.on("event", (event) => events.push(event));
      const error =
        status === "failed"
          ? {
              message: "usage limit reached",
              codexErrorInfo: "usageLimitExceeded",
              additionalDetails: "Provider-supplied diagnostic text.",
            }
          : null;
      sendRequest.mockResolvedValueOnce({
        turn: { id: `turn_${status}`, status, items: [], error },
      });

      await expect(
        manager.sendTurn({ threadId: asThreadId("thread_1"), input: "hello" }),
      ).resolves.toMatchObject({ turnId: `turn_${status}` });
      expect(updateSession).toHaveBeenLastCalledWith(context, {
        status: sessionStatus,
        activeTurnId: undefined,
        lastError: status === "failed" ? "usage limit reached" : undefined,
      });
      expect(updateSession).not.toHaveBeenCalledWith(
        context,
        expect.objectContaining({
          status: "running",
          activeTurnId: `turn_${status}`,
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          method: "turn/completed",
          turnId: `turn_${status}`,
          payload: expect.objectContaining({
            turn: expect.objectContaining({
              id: `turn_${status}`,
              status,
              error,
            }),
          }),
        }),
      );
    },
  );

  it("keeps an in-progress turn/start result running", async () => {
    const { manager, context, sendRequest, updateSession } = createSendTurnHarness();
    sendRequest.mockResolvedValueOnce({
      turn: {
        id: "turn_running",
        status: "inProgress",
        items: [],
        error: null,
      },
    });
    await expect(
      manager.sendTurn({ threadId: asThreadId("thread_1"), input: "hello" }),
    ).resolves.toMatchObject({ turnId: "turn_running" });
    expect(updateSession).toHaveBeenLastCalledWith(
      context,
      expect.objectContaining({
        status: "running",
        activeTurnId: "turn_running",
      }),
    );
  });

  it("does not resurrect a turn when its terminal notification wins the response race", async () => {
    const { manager, context, sendRequest, updateSession } = createSendTurnHarness();
    let resolveResponse!: (value: unknown) => void;
    sendRequest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveResponse = resolve;
        }),
    );
    const pending = manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "hello",
    });
    await Promise.resolve();
    const terminalNotification = {
      method: "turn/completed",
      params: {
        threadId: "thread_1",
        turn: {
          id: "turn_raced",
          status: "failed",
          items: [],
          error: { message: "failed" },
        },
      },
    };
    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: unknown) => void;
      }
    ).handleServerNotification(context, terminalNotification);
    resolveResponse({
      turn: { id: "turn_raced", status: "inProgress", items: [], error: null },
    });
    await expect(pending).resolves.toMatchObject({ turnId: "turn_raced" });
    expect(updateSession).not.toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        status: "running",
        activeTurnId: "turn_raced",
      }),
    );

    updateSession.mockClear();
    context.session.status = "running";
    context.session.activeTurnId = "turn_successor";
    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: unknown) => void;
      }
    ).handleServerNotification(context, terminalNotification);
    expect(updateSession).not.toHaveBeenCalled();
    expect(context.session.activeTurnId).toBe("turn_successor");
  });

  it("sends text and image user input items to turn/start", async () => {
    const { manager, context, requireSession, sendRequest, updateSession } =
      createSendTurnHarness();

    const result = await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Inspect this image",
      attachments: [
        {
          type: "image",
          url: "data:image/png;base64,AAAA",
        },
      ],
      model: "gpt-5.3",
      serviceTier: "fast",
      effort: "high",
    });

    expect(result).toEqual({
      threadId: "thread_1",
      turnId: "turn_1",
      resumeCursor: { threadId: "thread_1" },
    });
    expect(requireSession).toHaveBeenCalledWith("thread_1");
    expect(sendRequest).toHaveBeenCalledWith(
      context.transport,
      context.session.threadId,
      "turn/start",
      {
        threadId: "thread_1",
        ...fullAccessTurnOverrides,
        summary: "auto",
        input: [
          {
            type: "text",
            text: "Inspect this image",
            text_elements: [],
          },
          {
            type: "image",
            url: "data:image/png;base64,AAAA",
          },
        ],
        model: "gpt-5.3",
        serviceTier: "fast",
        effort: "high",
        collaborationMode: {
          mode: "default",
          settings: {
            model: "gpt-5.3",
            reasoning_effort: "high",
            developer_instructions: CODEX_DEVELOPER_INSTRUCTIONS,
          },
        },
      },
    );
    expect(updateSession).toHaveBeenCalledWith(context, {
      status: "running",
      activeTurnId: "turn_1",
      resumeCursor: { threadId: "thread_1" },
    });
  });

  it("uses approval-required Codex overrides on turn/start", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness("approval-required");

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Check this before changing files",
    });

    expect(sendRequest).toHaveBeenCalledWith(
      context.transport,
      context.session.threadId,
      "turn/start",
      {
        threadId: "thread_1",
        ...approvalRequiredTurnOverrides,
        approvalPolicy: "never",
        summary: "auto",
        input: [
          {
            type: "text",
            text: "Check this before changing files",
            text_elements: [],
          },
        ],
        model: "gpt-5.3-codex",
        collaborationMode: {
          mode: "default",
          settings: {
            model: "gpt-5.3-codex",
            reasoning_effort: "medium",
            developer_instructions: CODEX_DEVELOPER_INSTRUCTIONS,
          },
        },
      },
    );
  });
});

describe("steerTurn", () => {
  it("steers the active Codex turn when the session is already running", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness();
    context.session.status = "running";
    context.session.activeTurnId = "turn_active";
    context.collabReceiverTurns.set("child_provider_1", "turn_active");
    sendRequest.mockResolvedValueOnce({
      turnId: "turn_active",
    });

    const result = await manager.steerTurn({
      threadId: asThreadId("thread_1"),
      clientMessageId: MessageId.make("message_steer_1"),
      input: "Keep going",
    });

    expect(result).toEqual({
      threadId: "thread_1",
      turnId: "turn_active",
      resumeCursor: { threadId: "thread_1" },
    });
    expect(sendRequest).toHaveBeenCalledWith(
      context.transport,
      context.session.threadId,
      "turn/steer",
      {
        threadId: "thread_1",
        input: [
          {
            type: "text",
            text: "Keep going",
            text_elements: [],
          },
        ],
        expectedTurnId: "turn_active",
        clientUserMessageId: "message_steer_1",
      },
    );
    expect(context.collabReceiverTurns.get("child_provider_1")).toBe("turn_active");
  });

  it("requires turn/steer to return the active turn id", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness();
    context.session.status = "running";
    context.session.activeTurnId = "turn_active";
    sendRequest.mockResolvedValueOnce({});

    await expect(
      manager.steerTurn({
        threadId: asThreadId("thread_1"),
        input: "Keep going",
      }),
    ).rejects.toThrow("turn/steer response did not include a turn id.");
  });

  it("starts a new turn after a rejected steer when authoritative thread state is idle", async () => {
    const { manager, context, sendRequest, updateSession } = createSendTurnHarness();
    context.session.status = "running";
    context.session.activeTurnId = "turn_completed";
    const steerError = new Error("turn/steer failed");
    sendRequest
      .mockRejectedValueOnce(steerError)
      .mockResolvedValueOnce({
        thread: { id: "thread_1", status: { type: "idle" }, turns: [] },
      })
      .mockResolvedValueOnce({ turn: { id: "turn_new" } });

    const result = await manager.steerTurn({
      threadId: asThreadId("thread_1"),
      input: "Use this as the next turn",
    });

    expect(result.turnId).toBe("turn_new");
    expect(sendRequest.mock.calls.map(([, , method]) => method)).toEqual([
      "turn/steer",
      "thread/read",
      "turn/start",
    ]);
    expect(updateSession).toHaveBeenCalledWith(context, {
      status: "ready",
      activeTurnId: undefined,
      lastError: undefined,
    });
  });

  it("does not retry a rejected steer while authoritative thread state remains active", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness();
    context.session.status = "running";
    context.session.activeTurnId = "turn_active";
    const steerError = new Error("turn/steer failed");
    sendRequest.mockRejectedValueOnce(steerError).mockResolvedValueOnce({
      thread: { id: "thread_1", status: { type: "active" }, turns: [] },
    });

    await expect(
      manager.steerTurn({
        threadId: asThreadId("thread_1"),
        input: "Keep going",
      }),
    ).rejects.toBe(steerError);
    expect(sendRequest.mock.calls.map(([, , method]) => method)).toEqual([
      "turn/steer",
      "thread/read",
    ]);
  });
});

describe("CodexAppServerManager discovery", () => {
  it("rejects voice lookup instead of reusing an unrelated active Connection session", async () => {
    const manager = new CodexAppServerManager();
    const activeContext = {
      transport: {
        key: "test-account",
        cwd: "/repo-a",
        connectionIds: new Set(),
        token: Symbol("test-account"),
        threads: new Set<unknown>(),
        probes: new Map(),
        stopping: false,
        account: {
          type: "unknown",
          planType: null,
          sparkEnabled: true,
        },
        child: {
          killed: false,
        },
        pending: new Map(),
        nextRequestId: 1,
      },
      session: {
        provider: "codex",
        status: "ready",
        threadId: "thread_active",
        runtimeMode: "full-access",
        model: "gpt-5.3-codex",
        cwd: "/repo-a",
        resumeCursor: { threadId: "thread_active" },
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-10T00:00:00.000Z",
      },
      output: {
        close: vi.fn(),
      },
      pendingUserInputs: new Map(),
      collabReceiverTurns: new Map(),
      collabReceiverParents: new Map(),
      stopping: false,
    };
    activeContext.transport.threads.add(activeContext);
    (
      manager as unknown as {
        sessions: Map<string, unknown>;
      }
    ).sessions.set("thread_active", activeContext);

    const getOrCreateManagedProcess = vi
      .spyOn(
        manager as unknown as {
          getOrCreateManagedProcess: (cwd: string) => Promise<unknown>;
        },
        "getOrCreateManagedProcess",
      )
      .mockRejectedValue(new Error("must not be called"));
    const sendRequest = vi
      .spyOn(
        manager as unknown as {
          sendRequest: (...args: unknown[]) => Promise<unknown>;
        },
        "sendRequest",
      )
      .mockResolvedValue({
        result: {
          skills: [],
        },
      });

    await expect(
      (
        manager as unknown as {
          requireVoiceThreadAccountProcess(threadId: string, cwd: string): Promise<unknown>;
        }
      ).requireVoiceThreadAccountProcess("thread_missing", "/repo-b"),
    ).rejects.toThrow("Unknown session for thread: thread_missing");
    expect(getOrCreateManagedProcess).not.toHaveBeenCalled();
    expect(sendRequest).not.toHaveBeenCalled();
  });

  it("rejects voice lookup without an exact thread", async () => {
    const manager = new CodexAppServerManager();
    const deadContext = {
      transport: {
        key: "test-account",
        cwd: "test-cwd",
        connectionIds: new Set(),
        token: Symbol("test-account"),
        threads: new Set<unknown>(),
        probes: new Map(),
        stopping: false,
        child: {
          exitCode: null,
          signalCode: null,
          killed: true,
          stdin: new PassThrough(),
        },
      },
      session: {
        provider: "codex",
        status: "closed",
        threadId: "thread_dead",
        runtimeMode: "full-access",
      },
      stopping: true,
    };
    deadContext.transport.threads.add(deadContext);
    (
      manager as unknown as {
        sessions: Map<string, unknown>;
      }
    ).sessions.set("thread_dead", deadContext);
    const getOrCreateManagedProcess = vi
      .spyOn(
        manager as unknown as {
          getOrCreateManagedProcess: (cwd: string) => Promise<unknown>;
        },
        "getOrCreateManagedProcess",
      )
      .mockRejectedValue(new Error("must not be called"));

    await expect(
      (
        manager as unknown as {
          requireVoiceThreadAccountProcess: () => Promise<unknown>;
        }
      ).requireVoiceThreadAccountProcess(),
    ).rejects.toThrow("requires an exact active thread session");
    expect(getOrCreateManagedProcess).not.toHaveBeenCalled();
  });
});

describe("provider thread control", () => {
  it("retains the exact native rollout path from thread/read", async () => {
    const { manager, sendRequest } = createThreadControlHarness();
    sendRequest.mockResolvedValueOnce({
      thread: { id: "thread_1", path: "/profile/sessions/exact.jsonl", turns: [] },
    });
    await manager.readThread(asThreadId("thread_1"));
    expect(manager.getNativeThreadPath(asThreadId("thread_1"))).toBe(
      "/profile/sessions/exact.jsonl",
    );
  });
  it("reads thread turns from thread/read", async () => {
    const { manager, context, requireSession, sendRequest } = createThreadControlHarness();
    sendRequest.mockResolvedValue({
      thread: {
        id: "thread_1",
        turns: [
          {
            id: "turn_1",
            items: [
              {
                type: "userMessage",
                content: [{ type: "text", text: "hello" }],
              },
            ],
          },
        ],
      },
    });

    const result = await manager.readThread(asThreadId("thread_1"));

    expect(requireSession).toHaveBeenCalledWith("thread_1");
    expect(sendRequest).toHaveBeenCalledWith(
      context.transport,
      context.session.threadId,
      "thread/read",
      {
        threadId: "thread_1",
        includeTurns: true,
      },
    );
    expect(result).toEqual({
      threadId: "thread_1",
      cwd: null,
      turns: [
        {
          id: "turn_1",
          items: [{ type: "userMessage", content: [{ type: "text", text: "hello" }] }],
        },
      ],
    });
  });

  it("reads thread turns from flat thread/read responses", async () => {
    const { manager, context, sendRequest } = createThreadControlHarness();
    sendRequest.mockResolvedValue({
      threadId: "thread_1",
      turns: [
        {
          id: "turn_1",
          items: [{ type: "userMessage", content: [{ type: "text", text: "hello" }] }],
        },
      ],
    });

    const result = await manager.readThread(asThreadId("thread_1"));

    expect(sendRequest).toHaveBeenCalledWith(
      context.transport,
      context.session.threadId,
      "thread/read",
      {
        threadId: "thread_1",
        includeTurns: true,
      },
    );
    expect(result).toEqual({
      threadId: "thread_1",
      cwd: null,
      turns: [
        {
          id: "turn_1",
          items: [{ type: "userMessage", content: [{ type: "text", text: "hello" }] }],
        },
      ],
    });
  });

  it("reverts a paginated thread before the exact turn and resets session running state", async () => {
    const { manager, context, sendRequest, updateSession } = createThreadControlHarness();
    sendRequest.mockResolvedValue({
      thread: {
        id: "thread_1",
        turns: [],
      },
    });

    const result = await manager.revertThread(asThreadId("thread_1"), asTurnId("turn_replaced"));

    expect(sendRequest).toHaveBeenCalledWith(
      context.transport,
      context.session.threadId,
      "thread/revert",
      {
        threadId: "thread_1",
        beforeTurnId: "turn_replaced",
      },
    );
    expect(updateSession).toHaveBeenCalledWith(context, {
      status: "ready",
      activeTurnId: undefined,
    });
    expect(result).toEqual({
      threadId: "thread_1",
      cwd: null,
      turns: [],
    });
  });

  it("reads the exact active review turn before interrupting once", async () => {
    const { manager, context, sendRequest, updateSession } = createThreadControlHarness();
    context.session.status = "running";
    context.session.activeTurnId = "turn_review_old";
    context.reviewTurnIds.add("turn_review_old");

    sendRequest
      .mockResolvedValueOnce({
        thread: {
          id: "thread_1",
          turns: [
            {
              id: "turn_review_new",
              status: "inProgress",
              items: [{ type: "enteredReviewMode" }],
            },
          ],
        },
      })
      .mockResolvedValueOnce({});

    await manager.interruptTurn(asThreadId("thread_1"));

    expect(sendRequest).toHaveBeenNthCalledWith(
      1,
      context.transport,
      context.session.threadId,
      "thread/read",
      {
        threadId: "thread_1",
        includeTurns: true,
      },
    );
    expect(sendRequest).toHaveBeenNthCalledWith(
      2,
      context.transport,
      context.session.threadId,
      "turn/interrupt",
      {
        threadId: "thread_1",
        turnId: "turn_review_new",
      },
    );
    expect(updateSession).toHaveBeenCalledWith(context, {
      activeTurnId: "turn_review_new",
    });
    expect(sendRequest).toHaveBeenCalledTimes(2);
  });

  it("does not retry a rejected review interrupt", async () => {
    const { manager, context, sendRequest } = createThreadControlHarness();
    context.session.status = "running";
    context.session.activeTurnId = "review";
    context.reviewTurnIds.add("review");
    sendRequest
      .mockResolvedValueOnce({
        thread: { id: "thread_1", turns: [{ id: "review", status: "inProgress", items: [] }] },
      })
      .mockRejectedValueOnce(new Error("native interrupt rejected"));
    await expect(manager.interruptTurn(asThreadId("thread_1"))).rejects.toThrow(
      "native interrupt rejected",
    );
    expect(sendRequest.mock.calls.map((call) => call[2])).toEqual([
      "thread/read",
      "turn/interrupt",
    ]);
  });

  it("settles review interrupt when thread/read already shows exited review mode", async () => {
    const { manager, context, sendRequest, updateSession } = createThreadControlHarness();
    context.session.status = "running";
    context.session.activeTurnId = "turn_review_old";
    context.reviewTurnIds.add("turn_review_old");

    sendRequest.mockResolvedValueOnce({
      thread: {
        id: "thread_1",
        turns: [
          {
            id: "turn_review_old",
            status: "completed",
            items: [{ type: "enteredReviewMode" }, { type: "exitedReviewMode" }],
          },
        ],
      },
    });

    await manager.interruptTurn(asThreadId("thread_1"));

    expect(updateSession).toHaveBeenCalledWith(context, {
      status: "ready",
      activeTurnId: undefined,
      lastError: undefined,
    });
    expect(sendRequest).toHaveBeenCalledTimes(1);
    expect(sendRequest.mock.calls[0]?.[2]).toBe("thread/read");
  });
});

describe("respondToUserInput", () => {
  it("serializes canonical answers to Codex native answer objects", async () => {
    const { manager, context, requireSession, writeMessage, emitEvent } =
      createPendingUserInputHarness();

    await manager.respondToUserInput(asThreadId("thread_1"), "req-user-input-1", {
      scope: "All request methods",
      compat: "Keep current envelope",
    });

    expect(requireSession).toHaveBeenCalledWith("thread_1");
    expect(writeMessage).toHaveBeenCalledWith(context.transport, {
      id: 42,
      result: {
        answers: {
          scope: { answers: ["All request methods"] },
          compat: { answers: ["Keep current envelope"] },
        },
      },
    });
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "item/tool/requestUserInput/answered",
        payload: {
          requestId: "req-user-input-1",
          answers: {
            scope: { answers: ["All request methods"] },
            compat: { answers: ["Keep current envelope"] },
          },
        },
      }),
    );
  });

  it("preserves explicit empty multi-select answers", async () => {
    const { manager, context, requireSession, writeMessage, emitEvent } =
      createPendingUserInputHarness();

    await manager.respondToUserInput(asThreadId("thread_1"), "req-user-input-1", {
      scope: [],
    });

    expect(requireSession).toHaveBeenCalledWith("thread_1");
    expect(writeMessage).toHaveBeenCalledWith(context.transport, {
      id: 42,
      result: {
        answers: {
          scope: { answers: [] },
        },
      },
    });
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "item/tool/requestUserInput/answered",
        payload: {
          requestId: "req-user-input-1",
          answers: {
            scope: { answers: [] },
          },
        },
      }),
    );
  });
});

describe("collab child conversation routing", () => {
  it("preserves child notification turn ids and annotates the parent turn", () => {
    const { manager, context, emitEvent } = createCollabNotificationHarness();

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          id: "call_collab_1",
          receiverThreadIds: ["child_provider_1"],
        },
        threadId: "provider_parent",
        turnId: "turn_parent",
      },
    });

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "item/agentMessage/delta",
      params: {
        threadId: "child_provider_1",
        turnId: "turn_child_1",
        itemId: "msg_child_1",
        delta: "working",
      },
    });

    expect(emitEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: "item/agentMessage/delta",
        turnId: "turn_child_1",
        parentTurnId: "turn_parent",
        itemId: "msg_child_1",
        providerThreadId: "child_provider_1",
        providerParentThreadId: "provider_parent",
      }),
    );
  });

  it("routes unmapped child assistant notifications through the active provider thread", () => {
    const { manager, context, emitEvent } = createCollabNotificationHarness();

    handleServerNotificationForTest(manager, context, {
      method: "item/agentMessage/delta",
      params: {
        threadId: "child_provider_unmapped",
        turnId: "turn_child_unmapped",
        itemId: "msg_child_unmapped",
        delta: "working",
      },
    });
    handleServerNotificationForTest(manager, context, {
      method: "item/completed",
      params: {
        threadId: "child_provider_unmapped",
        turnId: "turn_child_unmapped",
        item: {
          type: "agentMessage",
          id: "msg_child_unmapped",
          text: "done",
        },
      },
    });

    expect(emitEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: "item/agentMessage/delta",
        turnId: "turn_child_unmapped",
        itemId: "msg_child_unmapped",
        providerThreadId: "child_provider_unmapped",
        providerParentThreadId: "provider_parent",
      }),
    );
    expect(emitEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "item/completed",
        turnId: "turn_child_unmapped",
        itemId: "msg_child_unmapped",
        providerThreadId: "child_provider_unmapped",
        providerParentThreadId: "provider_parent",
      }),
    );
  });

  it("preserves an unmapped child user-input route through the answered event", async () => {
    const { manager, context, emitEvent, writeMessage } = createCollabNotificationHarness();

    await handleServerRequestForTest(manager, context, {
      id: 43,
      method: "item/tool/requestUserInput",
      params: {
        threadId: "child_provider_unmapped",
        turnId: "turn_child_unmapped",
        itemId: "tool_child_unmapped",
        questions: [
          {
            id: "scope",
            header: "Scope",
            question: "Which scope should this change target?",
            options: [{ label: "child", description: "Only the child thread" }],
          },
        ],
      },
    });

    const pendingRequest = Array.from(context.pendingUserInputs.values())[0];
    expect(pendingRequest).toEqual(
      expect.objectContaining({
        providerThreadId: "child_provider_unmapped",
        providerParentThreadId: "provider_parent",
      }),
    );
    await manager.respondToUserInput(asThreadId("thread_1"), pendingRequest.requestId, {
      scope: "child",
    });

    expect(writeMessage).toHaveBeenCalledWith(context.transport, {
      id: 43,
      result: {
        answers: {
          scope: { answers: ["child"] },
        },
      },
    });
    expect(emitEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        kind: "request",
        method: "item/tool/requestUserInput",
        providerThreadId: "child_provider_unmapped",
        providerParentThreadId: "provider_parent",
      }),
    );
    expect(emitEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        kind: "notification",
        method: "item/tool/requestUserInput/answered",
        providerThreadId: "child_provider_unmapped",
        providerParentThreadId: "provider_parent",
      }),
    );
  });

  it("suppresses child lifecycle notifications without mutating the parent session state", () => {
    const { manager, context, emitEvent, updateSession } = createCollabNotificationHarness();

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          id: "call_collab_1",
          receiverThreadIds: ["child_provider_1"],
        },
        threadId: "provider_parent",
        turnId: "turn_parent",
      },
    });
    emitEvent.mockClear();
    updateSession.mockClear();

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "turn/started",
      params: {
        threadId: "child_provider_1",
        turn: { id: "turn_child_1" },
      },
    });

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "turn/completed",
      params: {
        threadId: "child_provider_1",
        turn: { id: "turn_child_1", status: "completed" },
      },
    });

    expect(emitEvent).not.toHaveBeenCalled();
    expect(updateSession).not.toHaveBeenCalled();
  });

  it("suppresses child lifecycle notifications that arrive before receiver mapping", () => {
    const { manager, context, emitEvent, updateSession } = createCollabNotificationHarness();
    context.session.status = "running";
    context.session.activeTurnId = "turn_parent";

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "turn/started",
      params: {
        threadId: "child_provider_unmapped",
        turn: { id: "turn_child_unmapped" },
      },
    });

    expect(emitEvent).not.toHaveBeenCalled();
    expect(updateSession).not.toHaveBeenCalled();
    expect(context.session.activeTurnId).toBe("turn_parent");
  });

  it("keeps a completed turn terminal when a background command emits late output", () => {
    const { manager, context, emitEvent, updateSession } = createCollabNotificationHarness();

    handleServerNotificationForTest(manager, context, {
      method: "turn/completed",
      params: {
        threadId: "provider_parent",
        turn: { id: "turn_parent", status: "completed" },
      },
    });
    updateSession.mockClear();
    emitEvent.mockClear();

    handleServerNotificationForTest(manager, context, {
      method: "item/commandExecution/outputDelta",
      params: {
        threadId: "provider_parent",
        turnId: "turn_parent",
        itemId: "exec-background",
        delta: "GET / 200 in 62ms",
      },
    });

    expect(context.terminalTurnIds).toContain("turn_parent");
    expect(updateSession).not.toHaveBeenCalled();
    expect(emitEvent).toHaveBeenCalledTimes(1);
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "item/commandExecution/outputDelta",
        turnId: "turn_parent",
      }),
    );
  });

  it("ignores a delayed duplicate start after the same turn completed", () => {
    const { manager, context, emitEvent, updateSession } = createCollabNotificationHarness();

    handleServerNotificationForTest(manager, context, {
      method: "turn/completed",
      params: {
        threadId: "provider_parent",
        turn: { id: "turn_parent", status: "completed" },
      },
    });
    updateSession.mockClear();
    emitEvent.mockClear();

    handleServerNotificationForTest(manager, context, {
      method: "turn/started",
      params: {
        threadId: "provider_parent",
        turn: { id: "turn_parent", status: "inProgress" },
      },
    });

    expect(context.terminalTurnIds).toContain("turn_parent");
    expect(updateSession).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("suppresses child lifecycle notifications when only the provider parent is known", () => {
    const { manager, context, emitEvent, updateSession } = createCollabNotificationHarness();
    context.collabReceiverParents.set("child_provider_1", "provider_parent");

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "turn/started",
      params: {
        threadId: "child_provider_1",
        turn: { id: "turn_child_1" },
      },
    });

    expect(emitEvent).not.toHaveBeenCalled();
    expect(updateSession).not.toHaveBeenCalled();
  });
});

describe("handleServerNotification error normalization", () => {
  it("does not infer turn completion from legacy task_complete or elapsed time", () => {
    vi.useFakeTimers();
    try {
      const { manager, context, updateSession, emitEvent } = createCollabNotificationHarness();
      handleServerNotificationForTest(manager, context, {
        method: "codex/event/task_complete",
        params: { id: "turn_parent", msg: { type: "task_complete", turn_id: "turn_parent" } },
      });
      vi.runAllTimers();
      expect(updateSession).not.toHaveBeenCalled();
      expect(
        emitEvent.mock.calls.filter(
          ([event]) => (event as ProviderEvent).method === "turn/completed",
        ),
      ).toHaveLength(0);
      handleServerNotificationForTest(manager, context, {
        method: "turn/completed",
        params: { threadId: "provider_parent", turn: { id: "turn_parent", status: "completed" } },
      });
      expect(
        emitEvent.mock.calls.filter(
          ([event]) => (event as ProviderEvent).method === "turn/completed",
        ),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles native review when review mode exits", () => {
    const { manager, context, updateSession, emitEvent } = createCollabNotificationHarness();
    context.reviewTurnIds.add("turn_parent");
    context.reviewTurnIds.add("turn_child");
    context.session.activeTurnId = "turn_child";

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "item/completed",
      params: {
        item: {
          type: "exitedReviewMode",
          id: "turn_parent",
          review: "The working tree is clean.",
        },
        threadId: "provider_parent",
      },
    });

    expect(updateSession).toHaveBeenCalledWith(context, {
      status: "ready",
      activeTurnId: undefined,
      lastError: undefined,
    });
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "notification",
        method: "turn/completed",
        turnId: "turn_child",
        threadId: "thread_1",
        payload: {
          turn: {
            id: "turn_child",
            status: "completed",
          },
        },
      }),
    );
  });

  it("clears the running session turn when Codex aborts a turn", () => {
    const { manager, context, updateSession } = createCollabNotificationHarness();

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "turn/aborted",
      params: {
        threadId: "provider_parent",
        turn: {
          id: "turn_parent",
          status: "interrupted",
        },
      },
    });

    expect(updateSession).toHaveBeenCalledWith(context, {
      status: "ready",
      activeTurnId: undefined,
      lastError: undefined,
    });
  });
});

describe("CodexAppServerManager process teardown", () => {
  it("keeps one stop in flight and publishes closed after exit proof", async () => {
    let proveExit: (() => void) | undefined;
    const exitProof = new Promise<void>((resolve) => {
      proveExit = resolve;
    });
    let enteredTeardown!: () => void;
    const teardownEntered = new Promise<void>((resolve) => {
      enteredTeardown = resolve;
    });
    const teardownProcessTree = vi.fn(async () => {
      enteredTeardown();
      await exitProof;
      return { escalated: false, signalErrors: [] };
    });
    const manager = new CodexAppServerManager(undefined, {
      teardownProcessTree,
    });
    const threadId = asThreadId("thread-stop-proof");
    const closedEvents: string[] = [];
    manager.on("event", (event) => {
      if (event.method === "session/closed") {
        closedEvents.push(event.method);
      }
    });
    const context = {
      transport: {
        key: "test-account",
        cwd: "test-cwd",
        connectionIds: new Set(),
        token: Symbol("test-account"),
        threads: new Set<unknown>(),
        probes: new Map(),
        stopping: false,
        account: { type: "unknown", planType: null, sparkEnabled: true },
        child: {
          pid: 42_424,
          exitCode: null,
          signalCode: null,
          once: vi.fn(),
          removeListener: vi.fn(),
        },
        stdinWriter: { close: vi.fn(), write: vi.fn().mockResolvedValue(undefined) },
        pending: new Map(),
        nextRequestId: 1,
      },
      session: {
        provider: "codex",
        status: "ready",
        threadId,
        runtimeMode: "full-access",
        model: "gpt-5.3-codex",
        activeTurnId: "turn-active",
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-10T00:00:00.000Z",
      },
      pendingUserInputs: new Map(),
      collabReceiverTurns: new Map(),
      collabReceiverParents: new Map(),
      reviewTurnIds: new Set(),
      terminalTurnIds: new Set(),
      stopping: false,
    };
    context.transport.threads.add(context);
    (
      manager as unknown as {
        sessions: Map<ThreadId, unknown>;
      }
    ).sessions.set(threadId, context);

    (manager as unknown as { accountProcesses: Map<string, unknown> }).accountProcesses.set(
      context.transport.key,
      { token: context.transport.token, process: Promise.resolve(context.transport) },
    );
    const firstStop = closeProcessForTest(manager, context.transport);
    const concurrentStop = closeProcessForTest(manager, context.transport);

    await teardownEntered;
    expect(teardownProcessTree).toHaveBeenCalledTimes(1);
    // The session becomes unroutable immediately, but closes only after exit proof.
    expect(closedEvents).toEqual([]);
    expect(manager.hasSession(threadId)).toBe(false);
    expect(manager.listSessions()).toHaveLength(0);
    expect(
      (
        manager as unknown as {
          accountProcesses: Map<string, unknown>;
        }
      ).accountProcesses.has(context.transport.key),
    ).toBe(true);

    proveExit?.();
    await Promise.all([firstStop, concurrentStop]);

    expect(closedEvents).toEqual(["session/closed"]);
    expect(manager.hasSession(threadId)).toBe(false);
    expect(manager.listSessions()).toHaveLength(0);
  });

  it("retains the replacement barrier and retries after teardown proof fails", async () => {
    const teardownProcessTree = vi
      .fn()
      .mockRejectedValueOnce(new Error("rootExited=false; surviving process remains"))
      .mockResolvedValueOnce({
        escalated: true,
        signalErrors: [],
      });
    const manager = new CodexAppServerManager(undefined, {
      teardownProcessTree,
    });
    const threadId = asThreadId("thread-stop-proof-retry");
    const closedEvents: string[] = [];
    manager.on("event", (event) => {
      if (event.method === "session/closed") {
        closedEvents.push(event.method);
      }
    });
    const context = {
      transport: {
        key: "test-account",
        cwd: "test-cwd",
        connectionIds: new Set(),
        token: Symbol("test-account"),
        threads: new Set<unknown>(),
        probes: new Map(),
        stopping: false,
        account: { type: "unknown", planType: null, sparkEnabled: true },
        child: {
          pid: 42_425,
          exitCode: null,
          signalCode: null,
          once: vi.fn(),
          removeListener: vi.fn(),
        },
        stdinWriter: { close: vi.fn(), write: vi.fn().mockResolvedValue(undefined) },
        pending: new Map(),
        nextRequestId: 1,
      },
      session: {
        provider: "codex",
        status: "ready",
        threadId,
        runtimeMode: "full-access",
        model: "gpt-5.3-codex",
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-10T00:00:00.000Z",
      },
      pendingUserInputs: new Map(),
      collabReceiverTurns: new Map(),
      collabReceiverParents: new Map(),
      reviewTurnIds: new Set(),
      terminalTurnIds: new Set(),
      stopping: false,
    };
    context.transport.threads.add(context);
    (
      manager as unknown as {
        sessions: Map<ThreadId, unknown>;
      }
    ).sessions.set(threadId, context);

    await expect(closeProcessForTest(manager, context.transport)).rejects.toThrow(
      "Failed to prove Codex account process-tree exit",
    );
    expect(manager.hasSession(threadId)).toBe(false);
    expect(manager.listSessions()).toHaveLength(0);
    expect(closedEvents).toEqual([]);

    await closeProcessForTest(manager, context.transport);
    expect(teardownProcessTree).toHaveBeenCalledTimes(2);
    expect(manager.listSessions()).toHaveLength(0);
    expect(closedEvents).toEqual(["session/closed"]);
  });
});
