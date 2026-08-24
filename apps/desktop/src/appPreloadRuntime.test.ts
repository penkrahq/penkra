import { describe, expect, it, vi } from "vitest";

import { AppPreloadRuntime, type AppPreloadRendererMessage } from "./appPreloadRuntime";

function fixture() {
  const sent: AppPreloadRendererMessage[] = [];
  const eventListeners = new Map<string, (payload: unknown) => void>();
  let hostListener: ((message: unknown) => void) | null = null;
  const ready = vi.fn();
  const tabSetRoute = vi.fn(async () => undefined);
  let browserStateListener: ((state: import("@penkra/sdk").AppBrowserSessionState) => void) | null =
    null;
  let simulatorStateListener:
    | ((state: import("@penkra/sdk").AppSimulatorSessionState) => void)
    | null = null;
  const browserCall = vi.fn(async () => ({
    version: 1,
    open: true,
    activePageId: "page-1",
    pages: [],
    extensionActions: [],
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
  const runtime = new AppPreloadRuntime({
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
    composerStage: vi.fn(),
    showContextMenu: vi.fn(async () => null),
  });
  runtime.start();
  return {
    runtime,
    sent,
    ready,
    tabSetRoute,
    browserCall,
    simulatorCall,
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

  it("announces readiness once and keeps operation registration in the Node controller", () => {
    const test = fixture();
    test.runtime.start();
    expect(test.ready).not.toHaveBeenCalled();
    test.runtime.markReady();
    test.runtime.markReady();
    expect(test.ready).toHaveBeenCalledOnce();

    expect(() => test.runtime.api.operations.handle("issues.create", vi.fn())).toThrow(
      "Node controller",
    );
  });

  it("exposes hosted browser calls and state without Electron primitives", async () => {
    const test = fixture();
    const listener = vi.fn();
    const unsubscribe = test.runtime.api.browser.onState(listener);
    const state = await test.runtime.api.browser.navigate({
      pageId: "page-1",
      url: "https://penkra.com",
    });
    expect(test.browserCall).toHaveBeenCalledWith("navigate", {
      pageId: "page-1",
      url: "https://penkra.com",
    });
    expect(state.open).toBe(true);
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

  it("shows native context menus without exposing Electron primitives", async () => {
    const test = fixture();
    await expect(
      test.runtime.api.contextMenu.show([
        { id: "uninstall", label: "Uninstall", destructive: true },
      ]),
    ).resolves.toBeNull();
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
        result: { route: "/document", state: { documentId: "doc-1" } },
      });
    });
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
