import { describe, expect, it, vi } from "vitest";

import type { AppTabHandle, OperationContext } from "@penkra/sdk";

import type { InstalledAppPackage } from "./appInstallationState";
import { AppControllerHost, type AppControllerRenderer } from "./appControllerHost";
import type { AppOperationController } from "./appOperationBroker";
import type { AppRendererRpcRequestOptions } from "./appRendererRpc";
import type { ActiveAppSession } from "./appSessionManager";

function installedApp(withOperations = true): InstalledAppPackage {
  const manifest = {
    manifestVersion: 1,
    id: "com.acme.linear",
    slug: "linear",
    name: "Linear",
    summary: "Manage Linear issues.",
    version: "1.0.0",
    compatibility: { penkra: ">=0.8.0" },
    icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml" }],
    entrypoints: withOperations
      ? { app: "app.html", operations: "operations.html" }
      : { app: "app.html" },
    ...(withOperations
      ? {
          operations: [
            {
              key: "issues.create",
              summary: "Create an issue.",
              input: { type: "object" },
              output: { type: "object" },
              handler: "issues.create",
            },
          ],
        }
      : {}),
  } as const;
  return {
    appId: manifest.id,
    slug: manifest.slug,
    name: manifest.name,
    summary: manifest.summary,
    version: manifest.version,
    source: "registry",
    packagePath: "/profile/apps/com.acme.linear/1.0.0",
    sha256: "a".repeat(64),
    installedAt: "2026-08-01T00:00:00.000Z",
    manifest,
  };
}

function fixture(app = installedApp()) {
  let destroyedListener: (() => void) | undefined;
  let controller: AppOperationController | undefined;
  let rpcOptions: AppRendererRpcRequestOptions | undefined;
  const renderer: AppControllerRenderer = {
    id: 44,
    send: vi.fn(),
    start: vi.fn(async () => undefined),
    destroy: vi.fn(),
    onDestroyed: vi.fn((listener) => {
      destroyedListener = listener;
      return vi.fn();
    }),
  };
  const unregisterController = vi.fn();
  const unregisterRpc = vi.fn();
  const broker = {
    registerController: vi.fn((value: AppOperationController) => {
      controller = value;
      return unregisterController;
    }),
  };
  const rpc = {
    registerTarget: vi.fn(() => unregisterRpc),
    request: vi.fn(async (_id, _method, _input, options) => {
      rpcOptions = options;
      return { created: true };
    }),
  };
  const host = new AppControllerHost({
    broker,
    rpc,
    renderers: { create: vi.fn(() => renderer) },
  });
  const session = {
    appId: app.appId,
    spaceId: "personal",
    partition: "persist:test",
    session: {} as ActiveAppSession["session"],
  };
  return {
    host,
    app,
    session,
    renderer,
    broker,
    rpc,
    controller: () => controller,
    rpcOptions: () => rpcOptions,
    destroyed: () => destroyedListener?.(),
    unregisterController,
    unregisterRpc,
  };
}

function operationContext(tab?: AppTabHandle): OperationContext {
  return {
    invocation: {
      id: "inv-1",
      app: "linear",
      operation: "issues.create",
      spaceId: "personal",
      threadId: "thread-1",
      ...(tab ? { tabId: tab.id } : {}),
    },
    ...(tab ? { tab } : {}),
    tabs: {
      open: vi.fn(async () => tabHandle("opened-tab")),
      openForResult: vi.fn(async () => ({ confirmed: true })),
    },
    signal: new AbortController().signal,
  };
}

function tabHandle(id: string): AppTabHandle {
  return {
    id,
    navigate: vi.fn(async () => undefined),
    navigateForResult: vi.fn(async () => ({ saved: true })),
    invoke: vi.fn(async () => ({ updated: true })),
  };
}

describe("AppControllerHost", () => {
  it("starts the declared controller before registering its operation handlers", async () => {
    const test = fixture();
    const release = await test.host.activate({
      installedApp: test.app,
      spaceId: "personal",
      session: test.session,
    });

    expect(test.renderer.start).toHaveBeenCalledWith(
      "penkra-app://com.acme.linear/operations.html",
    );
    expect(test.broker.registerController).toHaveBeenCalledAfter(test.renderer.start as never);
    expect(Object.keys(test.controller()?.handlers ?? {})).toEqual(["issues.create"]);
    await release();
    expect(test.unregisterController).toHaveBeenCalledOnce();
    expect(test.unregisterRpc).toHaveBeenCalledWith("app-disabled");
    expect(test.renderer.destroy).toHaveBeenCalledOnce();
  });

  it("does not create a controller renderer for a UI-only App", async () => {
    const test = fixture(installedApp(false));
    const release = await test.host.activate({
      installedApp: test.app,
      spaceId: "personal",
      session: test.session,
    });
    expect(test.renderer.start).not.toHaveBeenCalled();
    expect(test.broker.registerController).not.toHaveBeenCalled();
    await expect(release()).resolves.toBeUndefined();
  });

  it("passes declared input separately from host-owned invocation context", async () => {
    const test = fixture();
    await test.host.activate({
      installedApp: test.app,
      spaceId: "personal",
      session: test.session,
    });
    const handler = test.controller()?.handlers["issues.create"];
    expect(handler).toBeDefined();
    await handler?.({ title: "Fix redirect" }, operationContext());
    expect(test.rpc.request).toHaveBeenCalledWith(
      44,
      "controller.invoke",
      {
        operation: "issues.create",
        handler: "issues.create",
        input: { title: "Fix redirect" },
        invocation: expect.objectContaining({ id: "inv-1", app: "linear" }),
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("routes target-tab and newly opened tab handles only within the parent operation", async () => {
    const test = fixture();
    await test.host.activate({
      installedApp: test.app,
      spaceId: "personal",
      session: test.session,
    });
    const target = tabHandle("target-tab");
    const context = operationContext(target);
    await test.controller()?.handlers["issues.create"]?.({}, context);
    const call = test.rpcOptions()?.handleContextCall;
    expect(call).toBeDefined();
    if (!call) return;

    await expect(
      call(
        "context.tab.invoke",
        { operation: "selection.replace-text", input: { text: "New" } },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ updated: true });
    expect(target.invoke).toHaveBeenCalledOnce();

    const opened = await call(
      "context.tabs.open",
      { route: "/issues/new", state: { title: "New" } },
      new AbortController().signal,
    );
    expect(opened).toEqual({ id: "opened-tab" });
    await expect(
      call(
        "context.tab.navigate-for-result",
        { handleId: "opened-tab", route: "/issues/PEN-1" },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ saved: true });
  });

  it("rejects missing and forged tab handles with stable scoped codes", async () => {
    const test = fixture();
    await test.host.activate({
      installedApp: test.app,
      spaceId: "personal",
      session: test.session,
    });
    await test.controller()?.handlers["issues.create"]?.({}, operationContext());
    const call = test.rpcOptions()?.handleContextCall;
    if (!call) throw new Error("Context call handler missing.");

    await expect(
      call("context.tab.invoke", { operation: "issues.open", input: {} }, new AbortController().signal),
    ).rejects.toMatchObject({ code: "TAB_REQUIRED" });
    await expect(
      call(
        "context.tab.navigate",
        { handleId: "other-operation-tab", route: "/issues/1" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "TAB_HANDLE_INVALID" });
  });

  it("unregisters broker and transport when the controller renderer crashes", async () => {
    const test = fixture();
    await test.host.activate({
      installedApp: test.app,
      spaceId: "personal",
      session: test.session,
    });
    test.destroyed();
    await vi.waitFor(() => expect(test.unregisterController).toHaveBeenCalledOnce());
    expect(test.unregisterRpc).toHaveBeenCalledWith(undefined);
    expect(test.renderer.destroy).not.toHaveBeenCalled();
  });
});
