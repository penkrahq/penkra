import { afterEach, describe, expect, it, vi } from "vitest";

import {
  identity,
  account,
  operations,
  permissions,
  settings,
  tab,
  type PenkraAppRuntimeApi,
} from "./runtime";

afterEach(() => {
  delete (globalThis as { penkra?: PenkraAppRuntimeApi }).penkra;
});

function createFilesMock(): PenkraAppRuntimeApi["files"] {
  return {
    pick: vi.fn(async () => null),
    list: vi.fn(async () => []),
    readText: vi.fn(),
    writeText: vi.fn(),
    stat: vi.fn(),
    listDirectory: vi.fn(async () => []),
    readBinary: vi.fn(),
    writeBinary: vi.fn(),
    createDirectory: vi.fn(),
    rename: vi.fn(),
    remove: vi.fn(),
    watch: vi.fn(),
    openChild: vi.fn(),
    revoke: vi.fn(),
  };
}

function createBrowserMock(): PenkraAppRuntimeApi["browser"] {
  return {
    open: vi.fn(),
    close: vi.fn(),
    getState: vi.fn(),
    onState: vi.fn(),
    setViewport: vi.fn(),
    navigate: vi.fn(),
    reload: vi.fn(),
    stop: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    newPage: vi.fn(),
    closePage: vi.fn(),
    selectPage: vi.fn(),
    find: vi.fn(),
    stopFind: vi.fn(),
    capture: vi.fn(),
    evaluate: vi.fn(),
  };
}

describe("framework-neutral App runtime exports", () => {
  it("forwards operation and tab registration to the preload-owned global API", async () => {
    const runtime: PenkraAppRuntimeApi = {
      open: vi.fn(),
      contextMenu: { show: vi.fn(async () => null) },
      browser: createBrowserMock(),
      identity: { get: vi.fn(async () => ({ subject: "sub_test", space: "space_test" })) },
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
      files: createFilesMock(),
      network: { fetch: vi.fn() },
      sockets: { exchange: vi.fn() },
      processes: { run: vi.fn() },
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
      operations: { handle: vi.fn(() => vi.fn()) },
      tab: {
        setRoute: vi.fn(async () => undefined),
        handle: vi.fn(() => vi.fn()),
        onNavigate: vi.fn(() => vi.fn()),
      },
    };
    (globalThis as { penkra?: PenkraAppRuntimeApi }).penkra = runtime;
    const operationHandler = vi.fn();
    const tabHandler = vi.fn();
    const navigationHandler = vi.fn();

    operations.handle("issues.create", operationHandler);
    tab.handle("selection.replace-text", tabHandler);
    tab.onNavigate(navigationHandler);
    await tab.setRoute({ route: "/document", state: { documentId: "doc-1" } });

    expect(runtime.operations.handle).toHaveBeenCalledWith("issues.create", operationHandler);
    expect(runtime.tab.handle).toHaveBeenCalledWith("selection.replace-text", tabHandler);
    expect(runtime.tab.onNavigate).toHaveBeenCalledWith(navigationHandler);
    expect(runtime.tab.setRoute).toHaveBeenCalledWith({
      route: "/document",
      state: { documentId: "doc-1" },
    });
  });

  it("forwards read-only permission inspection to the preload-owned API", async () => {
    const runtime: PenkraAppRuntimeApi = {
      open: vi.fn(),
      contextMenu: { show: vi.fn(async () => null) },
      browser: createBrowserMock(),
      identity: { get: vi.fn(async () => ({ subject: "sub_test", space: "space_test" })) },
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
      files: createFilesMock(),
      network: { fetch: vi.fn() },
      sockets: { exchange: vi.fn() },
      processes: { run: vi.fn() },
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
      operations: { handle: vi.fn(() => vi.fn()) },
      tab: {
        setRoute: vi.fn(async () => undefined),
        handle: vi.fn(() => vi.fn()),
        onNavigate: vi.fn(() => vi.fn()),
      },
    };
    (globalThis as { penkra?: PenkraAppRuntimeApi }).penkra = runtime;
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

  it("fails clearly outside a Penkra App renderer", () => {
    expect(() => operations.handle("issues.create", vi.fn())).toThrow(
      "Penkra App runtime is unavailable",
    );
  });
});
