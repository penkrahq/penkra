import { afterEach, describe, expect, it, vi } from "vitest";

import {
  identity,
  files,
  account,
  permissions,
  settings,
  storage,
  transfer,
  tab,
  type PenkraTabRuntimeApi,
} from "./runtime";

afterEach(() => {
  delete (globalThis as { penkra?: PenkraTabRuntimeApi }).penkra;
});

function createBrowserMock(): PenkraTabRuntimeApi["browser"] {
  return {
    open: vi.fn(),
    close: vi.fn(),
    getState: vi.fn(),
    onState: vi.fn(),
    onDownload: vi.fn(),
    setSurfaceLayout: vi.fn(),
    navigate: vi.fn(),
    reload: vi.fn(),
    stop: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    newPage: vi.fn(),
    closePage: vi.fn(),
    selectPage: vi.fn(),
    openExtensionAction: vi.fn(),
    find: vi.fn(),
    stopFind: vi.fn(),
    capture: vi.fn(),
    evaluate: vi.fn(),
  };
}

function createFilesMock(): PenkraTabRuntimeApi["files"] {
  return {
    list: vi.fn(),
    pick: vi.fn(),
    open: vi.fn(),
    closeUrl: vi.fn(),
    revoke: vi.fn(),
    stat: vi.fn(),
    listDirectory: vi.fn(),
    readText: vi.fn(),
    readBinary: vi.fn(),
    beginWrite: vi.fn(),
    writeChunk: vi.fn(),
    commitWrite: vi.fn(),
    abortWrite: vi.fn(),
    writeText: vi.fn(),
    createDirectory: vi.fn(),
    watch: vi.fn(),
  };
}

function createStorageMock(): PenkraTabRuntimeApi["storage"] {
  return {
    open: vi.fn(),
    closeUrl: vi.fn(),
    writeFile: vi.fn(),
    remove: vi.fn(),
    list: vi.fn(),
    usage: vi.fn(),
  };
}

function createTransferMock(): PenkraTabRuntimeApi["transfer"] {
  return {
    begin: vi.fn(),
    send: vi.fn(),
    receive: vi.fn(),
    onProgress: vi.fn(),
  };
}

function createSimulatorMock(): PenkraTabRuntimeApi["simulator"] {
  return {
    getEnvironment: vi.fn(),
    listRuntimes: vi.fn(),
    listDeviceTypes: vi.fn(),
    listDevices: vi.fn(),
    createDevice: vi.fn(),
    eraseDevice: vi.fn(),
    deleteDevice: vi.fn(),
    requestSetup: vi.fn(),
    cancelSetup: vi.fn(),
    open: vi.fn(),
    close: vi.fn(),
    getState: vi.fn(),
    onState: vi.fn(),
    setViewport: vi.fn(),
    getTarget: vi.fn(),
    capture: vi.fn(),
    tap: vi.fn(),
    swipe: vi.fn(),
    type: vi.fn(),
    press: vi.fn(),
    rotate: vi.fn(),
  };
}

describe("framework-neutral App runtime exports", () => {
  it("forwards visual tab registration to the preload-owned global API", async () => {
    const runtime: PenkraTabRuntimeApi = {
      runtime: { kind: "tab" },
      contextMenu: { show: vi.fn(async () => null) },
      files: createFilesMock(),
      storage: createStorageMock(),
      transfer: createTransferMock(),
      composer: { stage: vi.fn() },
      open: vi.fn(),
      browser: createBrowserMock(),
      simulator: createSimulatorMock(),
      identity: {
        get: vi.fn(async () => ({ subject: "sub_test", space: "space_test" })),
        getToken: vi.fn(),
      },
      account: { request: vi.fn(), subscribe: vi.fn() },
      settings: {
        get: vi.fn(async () => "value"),
        set: vi.fn(async () => undefined),
        reset: vi.fn(async () => undefined),
      },
      secrets: {
        get: vi.fn(async () => null),
        set: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
      },
      network: { fetch: vi.fn() },
      permissions: {
        query: vi.fn(async (name) => ({
          name,
          declared: true,
          required: false,
          state: "granted" as const,
        })),
        request: vi.fn(async (name) => ({
          name,
          declared: true,
          required: false,
          state: "granted" as const,
        })),
      },
      tab: {
        getContext: vi.fn(),
        setRoute: vi.fn(async () => undefined),
        onVisibilityChange: vi.fn(() => vi.fn()),
        handle: vi.fn(() => vi.fn()),
        onNavigate: vi.fn(() => vi.fn()),
      },
    };
    (globalThis as { penkra?: PenkraTabRuntimeApi }).penkra = runtime;
    const tabHandler = vi.fn();
    const navigationHandler = vi.fn();
    const visibilityHandler = vi.fn();

    tab.handle("selection.replace-text", tabHandler);
    tab.onNavigate(navigationHandler);
    tab.onVisibilityChange(visibilityHandler);
    await tab.setRoute({ route: "/document", state: { documentId: "doc-1" } });
    await storage.usage();
    await files.open("handle-1", "movie.mp4");
    await transfer.begin({ url: "https://uploads.example/files" });

    expect(runtime.tab.handle).toHaveBeenCalledWith("selection.replace-text", tabHandler);
    expect(runtime.tab.onNavigate).toHaveBeenCalledWith(navigationHandler);
    expect(runtime.tab.onVisibilityChange).toHaveBeenCalledWith(visibilityHandler);
    expect(runtime.tab.setRoute).toHaveBeenCalledWith({
      route: "/document",
      state: { documentId: "doc-1" },
    });
    expect(runtime.storage.usage).toHaveBeenCalledOnce();
    expect(runtime.files.open).toHaveBeenCalledWith("handle-1", "movie.mp4");
    expect(runtime.transfer.begin).toHaveBeenCalledWith({
      url: "https://uploads.example/files",
    });
  });

  it("forwards read-only permission inspection to the preload-owned API", async () => {
    const runtime: PenkraTabRuntimeApi = {
      runtime: { kind: "tab" },
      contextMenu: { show: vi.fn(async () => null) },
      files: createFilesMock(),
      storage: createStorageMock(),
      transfer: createTransferMock(),
      composer: { stage: vi.fn() },
      open: vi.fn(),
      browser: createBrowserMock(),
      simulator: createSimulatorMock(),
      identity: {
        get: vi.fn(async () => ({ subject: "sub_test", space: "space_test" })),
        getToken: vi.fn(),
      },
      account: {
        request: vi.fn(async () => ({ status: 200, headers: {}, body: new Uint8Array() })),
        subscribe: vi.fn(async () => vi.fn()),
      },
      settings: {
        get: vi.fn(async () => "value"),
        set: vi.fn(async () => undefined),
        reset: vi.fn(async () => undefined),
      },
      secrets: {
        get: vi.fn(async () => null),
        set: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
      },
      network: { fetch: vi.fn() },
      permissions: {
        query: vi.fn(async (name) => ({
          name,
          declared: true,
          required: false,
          state: "granted" as const,
        })),
        request: vi.fn(async (name) => ({
          name,
          declared: true,
          required: false,
          state: "granted" as const,
        })),
      },
      tab: {
        getContext: vi.fn(),
        setRoute: vi.fn(async () => undefined),
        onVisibilityChange: vi.fn(() => vi.fn()),
        handle: vi.fn(() => vi.fn()),
        onNavigate: vi.fn(() => vi.fn()),
      },
    };
    (globalThis as { penkra?: PenkraTabRuntimeApi }).penkra = runtime;
    await expect(permissions.query("network-fetch")).resolves.toMatchObject({ state: "granted" });
    expect(runtime.permissions.query).toHaveBeenCalledWith("network-fetch");
    await expect(permissions.request("network-fetch")).resolves.toMatchObject({ state: "granted" });
    expect(runtime.permissions.request).toHaveBeenCalledWith("network-fetch");
    await expect(identity.get()).resolves.toEqual({ subject: "sub_test", space: "space_test" });
    await account.request({ path: "/notes" });
    expect(runtime.account.request).toHaveBeenCalledWith({ path: "/notes" });
    await expect(settings.get("display-name")).resolves.toBe("value");
    await settings.set("display-name", "Ada");
    await settings.reset("display-name");
    expect(runtime.settings.set).toHaveBeenCalledWith("display-name", "Ada");
  });

  it("fails clearly without an injected Penkra App runtime", () => {
    expect(() => tab.handle("selection.replace-text", vi.fn())).toThrow(
      "Penkra App runtime is unavailable",
    );
  });
});
