import { afterEach, describe, expect, it, vi } from "vitest";

import {
  identity,
  operations,
  permissions,
  settings,
  tab,
  type PenkraAppRuntimeApi,
} from "./runtime";

afterEach(() => {
  delete (globalThis as { penkra?: PenkraAppRuntimeApi }).penkra;
});

describe("framework-neutral App runtime exports", () => {
  it("forwards operation and tab registration to the preload-owned global API", () => {
    const runtime: PenkraAppRuntimeApi = {
      identity: { get: vi.fn(async () => ({ subject: "sub_test", space: "space_test" })) },
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
      files: {
        pick: vi.fn(async () => null),
        list: vi.fn(async () => []),
        readText: vi.fn(),
        writeText: vi.fn(),
        listDirectory: vi.fn(async () => []),
        openChild: vi.fn(),
        revoke: vi.fn(),
      },
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
      tab: { handle: vi.fn(() => vi.fn()), onNavigate: vi.fn(() => vi.fn()) },
    };
    (globalThis as { penkra?: PenkraAppRuntimeApi }).penkra = runtime;
    const operationHandler = vi.fn();
    const tabHandler = vi.fn();
    const navigationHandler = vi.fn();

    operations.handle("issues.create", operationHandler);
    tab.handle("selection.replace-text", tabHandler);
    tab.onNavigate(navigationHandler);

    expect(runtime.operations.handle).toHaveBeenCalledWith("issues.create", operationHandler);
    expect(runtime.tab.handle).toHaveBeenCalledWith("selection.replace-text", tabHandler);
    expect(runtime.tab.onNavigate).toHaveBeenCalledWith(navigationHandler);
  });

  it("forwards read-only permission inspection to the preload-owned API", async () => {
    const runtime: PenkraAppRuntimeApi = {
      identity: { get: vi.fn(async () => ({ subject: "sub_test", space: "space_test" })) },
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
      files: {
        pick: vi.fn(async () => null),
        list: vi.fn(async () => []),
        readText: vi.fn(),
        writeText: vi.fn(),
        listDirectory: vi.fn(async () => []),
        openChild: vi.fn(),
        revoke: vi.fn(),
      },
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
      tab: { handle: vi.fn(() => vi.fn()), onNavigate: vi.fn(() => vi.fn()) },
    };
    (globalThis as { penkra?: PenkraAppRuntimeApi }).penkra = runtime;
    await expect(permissions.query("network-fetch")).resolves.toMatchObject({ state: "granted" });
    expect(runtime.permissions.query).toHaveBeenCalledWith("network-fetch");
    await expect(permissions.request("network-fetch")).resolves.toMatchObject({ state: "granted" });
    expect(runtime.permissions.request).toHaveBeenCalledWith("network-fetch");
    await expect(identity.get()).resolves.toEqual({ subject: "sub_test", space: "space_test" });
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
