import { describe, expect, it, vi } from "vitest";

import {
  AppPreloadRuntime,
  type AppPreloadRendererMessage,
  type AppPreloadTransport,
} from "./appPreloadRuntime";

function fixture() {
  const sent: AppPreloadRendererMessage[] = [];
  const eventListeners = new Map<string, (payload: unknown) => void>();
  let hostListener: ((message: unknown) => void) | null = null;
  const ready = vi.fn();
  const tabSetRoute = vi.fn(async () => undefined);
  const tabOpenSibling = vi.fn(async () => ({ tabId: "tab-sibling" }));
  let browserStateListener: ((state: import("@penkra/sdk").AppBrowserSessionState) => void) | null =
    null;
  let simulatorStateListener:
    | ((state: import("@penkra/sdk").AppSimulatorSessionState) => void)
    | null = null;
  const browserCall = vi.fn(async () => ({
    version: 1,
    open: true,
    page: null,
    lastError: null,
  }));
  const simulatorCall = vi.fn(async () => ({
    version: 1,
    open: true,
    phase: "ready",
    device: null,
    target: { platform: "android", serial: "emulator-5554" },
    orientation: "portrait",
    lastError: null,
  }));
  const calls: Array<[string, unknown?]> = [];
  const initialThreadState = [
    {
      id: "thread-1",
      deckId: "deck-1",
      title: "First",
      order: 0,
      archived: false,
      phase: "idle" as const,
      activeTurnId: null,
      pendingQuestion: false,
      composer: { empty: true, owner: "none" as const, composeId: null },
      queued: { count: 0, hasAppSubmission: false },
      steering: { pending: false, hasAppSubmission: false },
      updatedAt: "2026-09-16T00:00:00.000Z",
    },
  ];
  const threadsCall = vi.fn(async (method: string) =>
    method === "list" ? initialThreadState : undefined,
  );
  const call: NonNullable<AppPreloadTransport["call"]> = async <Result = unknown>(
    method: string,
    input?: unknown,
  ): Promise<Result> => {
    calls.push(input === undefined ? [method] : [method, input]);
    return input as Result;
  };
  const runtime = new AppPreloadRuntime({
    call,
    onEvent: (name, listener) => {
      eventListeners.set(name, listener);
      return () => eventListeners.delete(name);
    },
    send: (message) => sent.push(message),
    onHostMessage: (listener) => {
      hostListener = listener;
      return () => {
        hostListener = null;
      };
    },
    ready,
    tabSetRoute,
    tabOpenSibling,
    tabGetContext: vi.fn(),
    queryPermission: vi.fn(async (name) => ({
      name,
      declared: true,
      required: false,
      state: "granted" as const,
    })),
    requestPermission: vi.fn(async (name) => ({
      name,
      declared: true,
      required: false,
      state: "granted" as const,
    })),
    getIdentity: vi.fn(async () => ({ subject: "sub_test", space: "space_test" })),
    getIdentityToken: vi.fn(async () => ({
      token: "header.payload.signature",
      expiresAt: "2026-08-18T12:05:00Z",
    })),
    getAccountProfile: vi.fn(async () => ({
      name: "Local Developer",
      email: "local-developer@penkra.test",
      emailVerified: true,
      avatarUrl: null,
    })),
    accountDataRequest: vi.fn(async () => ({
      status: 200,
      headers: {},
      body: new Uint8Array(),
    })),
    accountDataSubscribe: vi.fn(async () => () => undefined),
    settingGet: vi.fn(async () => "value"),
    settingSet: vi.fn(async () => undefined),
    settingReset: vi.fn(async () => undefined),
    secretGet: vi.fn(async () => null),
    secretSet: vi.fn(async () => undefined),
    secretDelete: vi.fn(async () => undefined),
    browserCall,
    onBrowserState: (listener) => {
      browserStateListener = listener;
      return () => {
        browserStateListener = null;
      };
    },
    onBrowserDownload: vi.fn(() => () => undefined),
    simulatorCall,
    onSimulatorState: (listener) => {
      simulatorStateListener = listener;
      return () => {
        simulatorStateListener = null;
      };
    },
    networkFetch: vi.fn(async () => ({
      url: "https://example.com/",
      status: 200,
      headers: {},
      body: new Uint8Array(),
    })),
    storageCall: vi.fn(),
    threadsCall,
    showContextMenu: vi.fn(async () => null),
  });
  runtime.start();
  return {
    runtime,
    sent,
    ready,
    tabSetRoute,
    tabOpenSibling,
    browserCall,
    simulatorCall,
    calls,
    threadsCall,
    initialThreadState,
    browserState: (state: import("@penkra/sdk").AppBrowserSessionState) =>
      browserStateListener?.(state),
    simulatorState: (state: import("@penkra/sdk").AppSimulatorSessionState) =>
      simulatorStateListener?.(state),
    event: (name: string, payload: unknown) => eventListeners.get(name)?.(payload),
    host: (message: unknown) => hostListener?.(message),
  };
}

describe("AppPreloadRuntime", () => {
  it("records the current App route through the narrow preload transport", async () => {
    const test = fixture();

    await test.runtime.api.tab.setRoute({ route: "/document", state: { documentId: "doc-1" } });

    expect(test.tabSetRoute).toHaveBeenCalledWith({
      route: "/document",
      state: { documentId: "doc-1" },
    });
  });

  it("opens a sibling App tab through the preload transport", async () => {
    const test = fixture();

    await expect(
      test.runtime.api.tab.openSibling({ route: "/", state: { url: "https://example.com" } }),
    ).resolves.toEqual({ tabId: "tab-sibling" });

    expect(test.tabOpenSibling).toHaveBeenCalledWith({
      route: "/",
      state: { url: "https://example.com" },
    });
  });

  it("reports retained tab visibility without exposing host internals", () => {
    const test = fixture();
    const listener = vi.fn();
    const unsubscribe = test.runtime.api.tab.onVisibilityChange(listener);

    test.event("lifecycle.visibility", { active: false });
    test.event("lifecycle.visibility", { active: true });
    test.event("lifecycle.visibility", { active: "yes" });

    expect(listener.mock.calls).toEqual([[{ active: false }], [{ active: true }]]);
    unsubscribe();
    test.event("lifecycle.visibility", { active: false });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("announces readiness once and omits operation registration from the tab runtime", () => {
    const test = fixture();
    test.runtime.start();
    expect(test.ready).not.toHaveBeenCalled();
    test.runtime.markReady();
    test.runtime.markReady();
    expect(test.ready).toHaveBeenCalledOnce();

    expect("operations" in test.runtime.api).toBe(false);
  });

  it("exposes hosted browser calls and state without Electron primitives", async () => {
    const test = fixture();
    const listener = vi.fn();
    const unsubscribe = test.runtime.api.browser.onState(listener);
    const state = await test.runtime.api.browser.navigate({
      pageId: "page-1",
      url: "https://penkra.com",
    });
    await test.runtime.api.browser.setToolbarHeight(84);
    expect(test.browserCall).toHaveBeenCalledWith("setToolbarHeight", 84);
    expect(test.browserCall).toHaveBeenCalledWith("navigate", {
      pageId: "page-1",
      url: "https://penkra.com",
    });
    expect(state.open).toBe(true);
    await test.runtime.api.browser.snapshot({ pageId: "page-1", depth: 4 });
    await test.runtime.api.browser.find({ pageId: "page-1", query: "Continue" });
    await test.runtime.api.browser.click({ pageId: "page-1", ref: "e7" });
    await test.runtime.api.browser.type({ pageId: "page-1", ref: "e8", text: "Hello" });
    expect(test.browserCall).toHaveBeenCalledWith("snapshot", { pageId: "page-1", depth: 4 });
    expect(test.browserCall).toHaveBeenCalledWith("find", {
      pageId: "page-1",
      query: "Continue",
    });
    expect(test.browserCall).toHaveBeenCalledWith("click", { pageId: "page-1", ref: "e7" });
    expect(test.browserCall).toHaveBeenCalledWith("type", {
      pageId: "page-1",
      ref: "e8",
      text: "Hello",
    });
    await expect(
      test.runtime.api.browser.upload({
        pageId: "page-1",
        ref: "e9",
        paths: ["attachments/proposal.pdf"],
      }),
    ).resolves.toEqual(expect.objectContaining({ open: true }));
    expect(test.browserCall).toHaveBeenCalledWith("upload", {
      pageId: "page-1",
      ref: "e9",
      paths: ["attachments/proposal.pdf"],
    });
    test.browserState(state);
    expect(listener).toHaveBeenCalledWith(state);
    unsubscribe();
    test.browserState(state);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("exposes hosted simulator calls and state without native process details", async () => {
    const test = fixture();
    const listener = vi.fn();
    const unsubscribe = test.runtime.api.simulator.onState(listener);
    const state = await test.runtime.api.simulator.open("pixel-8");
    expect(test.simulatorCall).toHaveBeenCalledWith("open", "pixel-8");
    expect(state.target).toEqual({ platform: "android", serial: "emulator-5554" });
    expect(state).not.toHaveProperty("port");
    expect(state).not.toHaveProperty("processId");
    test.simulatorState(state);
    expect(listener).toHaveBeenCalledWith(state);
    unsubscribe();
    test.simulatorState(state);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("delivers host-measured transfer progress through the runtime event surface", () => {
    const test = fixture();
    const listener = vi.fn();
    const unsubscribe = test.runtime.api.transfer.onProgress(listener);
    const progress = {
      id: "transfer-1",
      phase: "uploading" as const,
      movedBytes: 2048,
      totalBytes: 4096,
    };

    test.event("transfer.progress", progress);
    expect(listener).toHaveBeenCalledWith(progress);
    unsubscribe();
    test.event("transfer.progress", { ...progress, movedBytes: 4096 });
    expect(listener).toHaveBeenCalledOnce();
  });

  it("publishes one initial Thread Deck snapshot and later semantic host updates", async () => {
    const test = fixture();
    const listener = vi.fn();
    const unsubscribe = test.runtime.api.threads.onState(listener);

    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(test.initialThreadState));
    expect(test.threadsCall).toHaveBeenCalledWith("list");

    const running = [
      {
        ...test.initialThreadState[0]!,
        phase: "running" as const,
        activeTurnId: "turn-1",
        updatedAt: "2026-09-16T00:00:01.000Z",
      },
    ];
    test.event("threads.state", running);
    test.event("threads.state", running);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(running);

    unsubscribe();
    test.event("threads.state", test.initialThreadState);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("shows native context menus without exposing Electron primitives", async () => {
    const test = fixture();
    await expect(
      test.runtime.api.contextMenu.show([
        { id: "uninstall", label: "Uninstall", destructive: true },
      ]),
    ).resolves.toBeNull();
  });

  it("mirrors Electron shell names and private controller invocation", async () => {
    const test = fixture();
    await test.runtime.api.shell.showItemInFolder("/tmp/report.txt");
    await test.runtime.api.shell.trashItem("/tmp/old.txt");
    await test.runtime.api.controller.invoke("explorer.stat", { path: "/tmp/report.txt" });

    expect(test.calls).toEqual([
      ["shell.showItemInFolder", "/tmp/report.txt"],
      ["shell.trashItem", "/tmp/old.txt"],
      ["controller.invoke", { handler: "explorer.stat", input: { path: "/tmp/report.txt" } }],
    ]);
  });

  it("dispatches point-to-point tab operations and navigation", async () => {
    const test = fixture();
    const tabHandler = vi.fn(async (input) => ({ received: input }));
    const navigationHandler = vi.fn(async ({ route }) => ({ route }));
    test.runtime.api.tab.handle("selection.replace-text", tabHandler);
    test.runtime.api.tab.onNavigate(navigationHandler);

    test.host({
      type: "request",
      id: "tab-request",
      method: "tab.invoke",
      input: { operation: "selection.replace-text", input: { text: "Updated" } },
    });
    test.host({
      type: "request",
      id: "navigate-request",
      method: "tab.navigate-for-result",
      input: { route: "/canvas/2", state: { focus: "title" } },
    });

    await vi.waitFor(() => {
      expect(test.sent).toEqual(
        expect.arrayContaining([
          {
            type: "result",
            id: "tab-request",
            result: { received: { text: "Updated" } },
          },
          {
            type: "result",
            id: "navigate-request",
            result: { route: "/canvas/2" },
          },
        ]),
      );
    });
  });

  it("holds initial navigation until the App registers its handler", async () => {
    const test = fixture();
    test.host({
      type: "request",
      id: "initial-navigation",
      method: "tab.navigate",
      input: { route: "/document", state: { documentId: "doc-1" } },
    });

    await Promise.resolve();
    expect(test.sent).toEqual([]);

    const handler = vi.fn(async ({ route, state }) => ({ route, state }));
    test.runtime.api.tab.onNavigate(handler);

    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledWith(
        { route: "/document", state: { documentId: "doc-1" } },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(test.sent).toContainEqual({
        type: "result",
        id: "initial-navigation",
        result: null,
      });
    });
  });

  it("acknowledges ordinary navigation after the App accepts it without waiting for route work", async () => {
    const test = fixture();
    let finishNavigation!: () => void;
    const routeWork = new Promise<void>((resolve) => {
      finishNavigation = resolve;
    });
    const handler = vi.fn(() => routeWork);
    test.runtime.api.tab.onNavigate(handler);

    test.host({
      type: "request",
      id: "ordinary-navigation",
      method: "tab.navigate",
      input: { route: "/document", state: { documentId: "doc-1" } },
    });

    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    expect(test.sent).toContainEqual({
      type: "result",
      id: "ordinary-navigation",
      result: null,
    });

    finishNavigation();
  });

  it("keeps result navigation pending until the App finishes route work", async () => {
    const test = fixture();
    let finishNavigation!: (value: { opened: string }) => void;
    const routeWork = new Promise<{ opened: string }>((resolve) => {
      finishNavigation = resolve;
    });
    test.runtime.api.tab.onNavigate(() => routeWork);

    test.host({
      type: "request",
      id: "result-navigation",
      method: "tab.navigate-for-result",
      input: { route: "/document", state: { documentId: "doc-1" } },
    });

    await Promise.resolve();
    expect(test.sent).not.toContainEqual(expect.objectContaining({ id: "result-navigation" }));

    finishNavigation({ opened: "doc-1" });
    await vi.waitFor(() =>
      expect(test.sent).toContainEqual({
        type: "result",
        id: "result-navigation",
        result: { opened: "doc-1" },
      }),
    );
  });

  it("returns stable errors for missing handlers without exposing stacks", async () => {
    const test = fixture();
    test.host({
      type: "request",
      id: "request-1",
      method: "tab.invoke",
      input: { operation: "selection.replace-text", input: { text: "Updated" } },
    });
    await vi.waitFor(() => {
      expect(test.sent).toContainEqual({
        type: "error",
        id: "request-1",
        code: "TAB_HANDLER_NOT_REGISTERED",
        message: "Tab handler selection.replace-text is not registered.",
      });
    });
  });
});
