import type { TestProviderUpdate as OrchestrationEvent } from "./storeTestFixtures";
// FILE: wsNativeApi.test.ts
// Purpose: Verifies the WebSocket-backed NativeApi adapter and push listener fanout.
// Layer: Web transport tests
// Depends on: wsTransport mock plus contracts channel constants.

import {
  type ContextMenuItem,
  EventId,
  FolderId,
  SpaceId,
  ThreadId,
  type WsPushChannel,
  type WsPushData,
  type WsPushMessage,
  WS_CHANNELS,
  WS_METHODS,
  type WsPush,
  type ServerProviderStatus,
} from "@penkra/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requestMock = vi.fn<(...args: Array<unknown>) => Promise<unknown>>();
const disposeMock = vi.fn();
const showContextMenuFallbackMock =
  vi.fn<
    <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>
  >();
const channelListeners = new Map<string, Set<(message: WsPush) => void>>();
const latestPushByChannel = new Map<string, WsPush>();
const subscribeMock = vi.fn<
  (
    channel: string,
    listener: (message: WsPush) => void,
    options?: { replayLatest?: boolean },
  ) => () => void
>((channel, listener, options) => {
  const listeners = channelListeners.get(channel) ?? new Set<(message: WsPush) => void>();
  listeners.add(listener);
  channelListeners.set(channel, listeners);
  const latest = latestPushByChannel.get(channel);
  if (latest && options?.replayLatest) {
    listener(latest);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      channelListeners.delete(channel);
    }
  };
});

vi.mock("./wsTransport", () => {
  return {
    WsTransport: class MockWsTransport {
      request = requestMock;
      subscribe = subscribeMock;
      onStateChange() {
        return () => undefined;
      }
      onCompatibilityIssue() {
        return () => undefined;
      }
      onThreadStreamFailure() {
        return () => undefined;
      }
      getLatestPush(channel: string) {
        return latestPushByChannel.get(channel) ?? null;
      }
      getState() {
        return "open" as const;
      }
      dispose = disposeMock;
    },
  };
});

vi.mock("./contextMenuFallback", () => ({
  showContextMenuFallback: showContextMenuFallbackMock,
}));

let nextPushSequence = 1;

function emitPush<C extends WsPushChannel>(channel: C, data: WsPushData<C>): void {
  const listeners = channelListeners.get(channel);
  const message = {
    type: "push" as const,
    sequence: nextPushSequence++,
    channel,
    data,
  } as WsPushMessage<C>;
  latestPushByChannel.set(channel, message);
  if (!listeners) return;
  for (const listener of listeners) {
    listener(message);
  }
}

function getWindowForTest(): Window & typeof globalThis & { desktopBridge?: unknown } {
  const testGlobal = globalThis as typeof globalThis & {
    window?: Window & typeof globalThis & { desktopBridge?: unknown };
  };
  if (!testGlobal.window) {
    testGlobal.window = {} as Window & typeof globalThis & { desktopBridge?: unknown };
  }
  return testGlobal.window;
}

const defaultProviders: ReadonlyArray<ServerProviderStatus> = [
  {
    provider: "codex",
    status: "ready",
    available: true,
    authStatus: "authenticated",
    checkedAt: "2026-01-01T00:00:00.000Z",
  },
];

beforeEach(() => {
  vi.resetModules();
  requestMock.mockReset();
  disposeMock.mockReset();
  showContextMenuFallbackMock.mockReset();
  subscribeMock.mockClear();
  channelListeners.clear();
  latestPushByChannel.clear();
  nextPushSequence = 1;
  Reflect.deleteProperty(getWindowForTest(), "desktopBridge");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("wsNativeApi", () => {
  it("preserves the project workspace-change adapter", async () => {
    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();

    expect(api.folders.onWorkspaceChange).toBeTypeOf("function");
  });

  it("delivers and caches valid server.welcome payloads", async () => {
    const { createWsNativeApi, onServerWelcome } = await import("./wsNativeApi");

    createWsNativeApi();
    const listener = vi.fn();
    onServerWelcome(listener);

    const payload = { cwd: "/tmp/workspace", homeDir: "/Users/tester", projectName: "penkra-code" };
    emitPush(WS_CHANNELS.serverWelcome, payload);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining(payload));

    const lateListener = vi.fn();
    onServerWelcome(lateListener);

    expect(lateListener).toHaveBeenCalledTimes(1);
    expect(lateListener).toHaveBeenCalledWith(expect.objectContaining(payload));
  });

  it("preserves bootstrap ids from server.welcome payloads", async () => {
    const { createWsNativeApi, onServerWelcome } = await import("./wsNativeApi");

    createWsNativeApi();
    const listener = vi.fn();
    onServerWelcome(listener);

    emitPush(WS_CHANNELS.serverWelcome, {
      cwd: "/tmp/workspace",
      homeDir: "/Users/tester",
      projectName: "penkra-code",
      bootstrapFolderId: FolderId.makeUnsafe("project-1"),
      bootstrapThreadId: ThreadId.makeUnsafe("thread-1"),
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/tmp/workspace",
        homeDir: "/Users/tester",
        projectName: "penkra-code",
        bootstrapFolderId: "project-1",
        bootstrapThreadId: "thread-1",
      }),
    );
  });

  it("delivers successive server.welcome payloads to active listeners", async () => {
    const { createWsNativeApi, onServerWelcome } = await import("./wsNativeApi");

    createWsNativeApi();
    const listener = vi.fn();
    onServerWelcome(listener);

    emitPush(WS_CHANNELS.serverWelcome, {
      cwd: "/tmp/one",
      homeDir: "/Users/tester",
      projectName: "one",
    });
    emitPush(WS_CHANNELS.serverWelcome, {
      cwd: "/tmp/workspace",
      homeDir: "/Users/tester",
      projectName: "penkra-code",
    });

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cwd: "/tmp/workspace",
        homeDir: "/Users/tester",
        projectName: "penkra-code",
      }),
    );
  });

  it("delivers and caches valid server.configUpdated payloads", async () => {
    const { createWsNativeApi, onServerConfigUpdated } = await import("./wsNativeApi");

    createWsNativeApi();
    const listener = vi.fn();
    onServerConfigUpdated(listener);

    const payload = {
      providers: defaultProviders,
    } as const;
    emitPush(WS_CHANNELS.serverConfigUpdated, payload);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(payload);

    const lateListener = vi.fn();
    onServerConfigUpdated(lateListener);
    expect(lateListener).toHaveBeenCalledTimes(1);
    expect(lateListener).toHaveBeenCalledWith(payload);
  });

  it("delivers successive server.configUpdated payloads to active listeners", async () => {
    const { createWsNativeApi, onServerConfigUpdated } = await import("./wsNativeApi");

    createWsNativeApi();
    const listener = vi.fn();
    onServerConfigUpdated(listener);

    emitPush(WS_CHANNELS.serverConfigUpdated, {
      providers: defaultProviders,
    });
    emitPush(WS_CHANNELS.serverConfigUpdated, {
      providers: defaultProviders,
    });

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith({
      providers: defaultProviders,
    });
  });

  it("delivers and caches provider-only status updates", async () => {
    const { createWsNativeApi, onServerProviderStatusesUpdated } = await import("./wsNativeApi");

    createWsNativeApi();
    const listener = vi.fn();
    onServerProviderStatusesUpdated(listener);

    const payload = {
      providers: defaultProviders,
    } as const;
    emitPush(WS_CHANNELS.serverProviderStatusesUpdated, payload);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(payload);

    const lateListener = vi.fn();
    onServerProviderStatusesUpdated(lateListener);
    expect(lateListener).toHaveBeenCalledTimes(1);
    expect(lateListener).toHaveBeenCalledWith(payload);
  });

  it("delivers and caches server settings updates", async () => {
    const { createWsNativeApi, onServerSettingsUpdated } = await import("./wsNativeApi");

    createWsNativeApi();
    const listener = vi.fn();
    onServerSettingsUpdated(listener);

    const payload = {
      settings: {
        enableAssistantStreaming: true,
        addProjectBaseDirectory: "",
        textGenerationModelSelection: { provider: "codex", model: "gpt-5.4-mini" },
        providers: {
          codex: { enabled: true, customModels: [] },
          claudeAgent: { enabled: true, customModels: [] },
          opencode: {
            enabled: true,
            experimentalWebSockets: false,
            customModels: [],
          },
        },
        skills: { disabled: [] },
      },
    } as const;
    emitPush(WS_CHANNELS.serverSettingsUpdated, payload);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(payload);

    const lateListener = vi.fn();
    onServerSettingsUpdated(lateListener);
    expect(lateListener).toHaveBeenCalledTimes(1);
    expect(lateListener).toHaveBeenCalledWith(payload);
  });

  it("sends canonical navigation updates and returns committed rows", async () => {
    const result = { spaces: [], folders: [] };
    requestMock.mockResolvedValue(result);
    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();
    const input = {
      update: {
        action: "folder.create",
        folderId: FolderId.makeUnsafe("project-1"),
        spaceId: SpaceId.makeUnsafe("space-test"),
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
        createdAt: "2026-02-24T00:00:00.000Z",
      },
    } as const;
    expect(await api.cleanCore.updateNavigation(input)).toEqual(result);
    expect(requestMock).toHaveBeenCalledWith(WS_METHODS.cleanCoreUpdateNavigation, input);
  });

  it("forwards canonical question answers and lifecycle unchanged", async () => {
    requestMock.mockResolvedValue(undefined);
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();

    const input = {
      threadId: ThreadId.makeUnsafe("thread-1"),
      requestId: "request-1",
      answers: {
        Runtime: ["Bun", "Node"],
      },
      lifecycleGeneration: "generation-1",
    } as const;
    await api.cleanCore.answerThreadQuestion(input);

    expect(requestMock).toHaveBeenCalledWith(WS_METHODS.cleanCoreAnswerThreadQuestion, input);
  });

  it("forwards workspace file writes to the websocket project method", async () => {
    requestMock.mockResolvedValue({ relativePath: "plan.md" });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    await api.folders.writeFile({
      cwd: "/tmp/project",
      relativePath: "plan.md",
      contents: "# Plan\n",
    });

    expect(requestMock).toHaveBeenCalledWith(WS_METHODS.projectsWriteFile, {
      cwd: "/tmp/project",
      relativePath: "plan.md",
      contents: "# Plan\n",
    });
  });

  it("forwards workspace file reads to the websocket project method", async () => {
    requestMock.mockResolvedValue({
      relativePath: "src/app.ts",
      contents: "export {};\n",
      truncated: false,
    });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    await api.folders.readFile({
      cwd: "/tmp/project",
      relativePath: "src/app.ts",
    });

    expect(requestMock).toHaveBeenCalledWith(WS_METHODS.projectsReadFile, {
      cwd: "/tmp/project",
      relativePath: "src/app.ts",
    });
  });

  it("forwards local preview grant creation to the websocket project method", async () => {
    requestMock.mockResolvedValue({
      grant: "grant-token",
      expiresAt: "2026-01-01T00:00:00.000Z",
    });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    await api.folders.createLocalFilePreviewGrant({
      path: "/Users/tester/Downloads/shot.png",
    });

    expect(requestMock).toHaveBeenCalledWith(WS_METHODS.projectsCreateLocalFilePreviewGrant, {
      path: "/Users/tester/Downloads/shot.png",
    });
  });

  it("forwards server environment requests to the websocket server method", async () => {
    requestMock.mockResolvedValue({
      environmentId: "environment-1",
      label: "Test Host",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.38",
      capabilities: { repositoryIdentity: true },
    });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    await api.server.getEnvironment();

    expect(requestMock).toHaveBeenCalledWith(WS_METHODS.serverGetEnvironment);
  });

  it("fetches auth session state over HTTP", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          authenticated: false,
          auth: {
            policy: "loopback-browser",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["browser-session-cookie", "bearer-session-token"],
            sessionCookieName: "penkra_session",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    const result = await api.server.getAuthSession();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/session",
      expect.objectContaining({ credentials: "same-origin", method: "GET" }),
    );
    expect(result).toMatchObject({ authenticated: false });
  });

  it("posts auth bootstrap payloads over HTTP", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          authenticated: true,
          role: "client",
          sessionMethod: "browser-session-cookie",
          expiresAt: "2026-01-01T00:00:00.000Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    const result = await api.server.bootstrapAuth({ credential: "PAIRINGTOKEN" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/bootstrap",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({ credential: "PAIRINGTOKEN" }),
      }),
    );
    expect(result).toMatchObject({ authenticated: true, sessionMethod: "browser-session-cookie" });
  });

  it("logs out over HTTP and disposes the authenticated websocket transport", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ revoked: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    await expect(api.server.logoutAuthSession()).resolves.toEqual({ revoked: true });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/logout",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
      }),
    );
    expect(disposeMock).toHaveBeenCalledTimes(1);
  });

  it("forwards context menu metadata to desktop bridge", async () => {
    const showContextMenu = vi.fn().mockResolvedValue("delete");
    Object.defineProperty(getWindowForTest(), "desktopBridge", {
      configurable: true,
      writable: true,
      value: {
        showContextMenu,
      },
    });

    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();
    await api.contextMenu.show(
      [
        { id: "rename", label: "Rename thread" },
        { id: "unavailable-action", label: "Unavailable action", enabled: false },
        { id: "delete", label: "Delete", separatorBefore: true, destructive: true },
      ],
      { x: 200, y: 300 },
    );

    expect(showContextMenu).toHaveBeenCalledWith(
      [
        { id: "rename", label: "Rename thread" },
        { id: "unavailable-action", label: "Unavailable action", enabled: false },
        { id: "delete", label: "Delete", separatorBefore: true, destructive: true },
      ],
      { x: 200, y: 300 },
    );
  });

  it("uses fallback context menu when desktop bridge is unavailable", async () => {
    showContextMenuFallbackMock.mockResolvedValue("delete");
    Reflect.deleteProperty(getWindowForTest(), "desktopBridge");

    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();
    await api.contextMenu.show([{ id: "delete", label: "Delete", destructive: true }], {
      x: 20,
      y: 30,
    });

    expect(showContextMenuFallbackMock).toHaveBeenCalledWith(
      [{ id: "delete", label: "Delete", destructive: true }],
      { x: 20, y: 30 },
    );
  });

  it("uses the native desktop confirmation when the bridge is available", async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    Object.defineProperty(getWindowForTest(), "desktopBridge", {
      configurable: true,
      writable: true,
      value: { confirm },
    });

    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();
    await expect(api.dialogs.confirm("Log out of Penkra?")).resolves.toBe(true);

    expect(confirm).toHaveBeenCalledWith("Log out of Penkra?");
  });

  it("uses the bounded HTTP upload instead of WebSocket RPC for browser voice", async () => {
    Object.defineProperty(getWindowForTest(), "desktopBridge", {
      configurable: true,
      writable: true,
      value: { getWsUrl: () => "ws://127.0.0.1:3773/ws?token=desktop-secret" },
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ text: "hello" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();
    const result = await api.server.transcribeVoice({
      provider: "codex",
      connectionId: "connection-codex" as never,
      cwd: "/repo",
      audioBase64: "AQID",
      mimeType: "audio/wav",
      sampleRateHz: 24_000,
      durationMs: 1000,
    });

    expect(result).toEqual({ text: "hello" });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/voice/transcribe?"),
      expect.objectContaining({ method: "POST", body: expect.any(Blob) }),
    );
    const requestBody = fetchMock.mock.calls[0]?.[1]?.body;
    expect(requestBody).toBeInstanceOf(Blob);
    expect((requestBody as Blob).type).toBe("audio/wav");
    expect(Array.from(new Uint8Array(await (requestBody as Blob).arrayBuffer()))).toEqual([
      1, 2, 3,
    ]);
    expect(requestMock).not.toHaveBeenCalledWith(
      WS_METHODS.serverTranscribeVoice,
      expect.anything(),
    );
  });

  it("delegates desktop voice uploads to Electron main", async () => {
    const transcribeWithServer = vi.fn().mockResolvedValue({ text: "desktop transcript" });
    Object.defineProperty(getWindowForTest(), "desktopBridge", {
      configurable: true,
      writable: true,
      value: {
        getWsUrl: () => "ws://127.0.0.1:3773/ws?token=desktop-secret",
        voice: { transcribeWithServer },
      },
    });
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();
    const input = {
      provider: "codex" as const,
      connectionId: "connection-codex" as never,
      cwd: "/repo",
      audioBase64: "AQID",
      mimeType: "audio/wav",
      sampleRateHz: 24_000,
      durationMs: 1000,
    };

    await expect(api.server.transcribeVoice(input)).resolves.toEqual({
      text: "desktop transcript",
    });
    expect(transcribeWithServer).toHaveBeenCalledWith(input);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
