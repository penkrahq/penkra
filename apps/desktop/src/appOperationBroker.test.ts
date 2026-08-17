import { describe, expect, it, vi } from "vitest";

import {
  createEmptyAppInstallationState,
  registerVerifiedAppPackage,
  setSpaceAppEnabled,
  type AppInstallationState,
} from "./appInstallationState";
import {
  AppOperationBroker,
  AppOperationBrokerError,
  type AppTabEndpoint,
  type AppTabHost,
} from "./appOperationBroker";

function enabledState(): AppInstallationState {
  const installed = registerVerifiedAppPackage(
    createEmptyAppInstallationState(),
    {
      manifest: {
        manifestVersion: 2,
        id: "com.acme.linear",
        slug: "linear",
        name: "Linear",
        summary: "Manage Linear issues.",
        version: "1.0.0",
        compatibility: { penkra: ">=0.8.0" },
        icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml" }],
        entrypoints: { app: "app.html", operations: "operations.html" },
        operations: [
          {
            key: "issues.create",
            summary: "Create an issue.",
            input: { type: "object" },
            output: { type: "object" },
            handler: "issues.create",
          },
        ],
      },
      source: "registry",
      packagePath: "/profile/apps/com.acme.linear/1.0.0",
      sha256: "a".repeat(64),
      installedAt: "2026-08-01T00:00:00.000Z",
    },
    "personal",
  );
  return setSpaceAppEnabled(installed, {
    appId: "com.acme.linear",
    spaceId: "personal",
    enabled: true,
  });
}

function crossAppState(): AppInstallationState {
  const linear = enabledState();
  const installed = registerVerifiedAppPackage(
    linear,
    {
      manifest: {
        manifestVersion: 2,
        id: "com.acme.github",
        slug: "github",
        name: "GitHub",
        summary: "Manage GitHub issues.",
        version: "1.0.0",
        compatibility: { penkra: ">=0.8.0" },
        icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml" }],
        entrypoints: { app: "app.html", operations: "operations.html" },
        operations: [
          {
            key: "issues.search",
            summary: "Search issues.",
            input: { type: "object" },
            output: { type: "object" },
            handler: "issues.search",
          },
        ],
      },
      source: "registry",
      packagePath: "/profile/apps/com.acme.github/1.0.0",
      sha256: "b".repeat(64),
      installedAt: "2026-08-01T00:00:00.000Z",
    },
    "personal",
  );
  return setSpaceAppEnabled(installed, {
    appId: "com.acme.github",
    spaceId: "personal",
    enabled: true,
  });
}

function tab(id: string, overrides: Partial<AppTabEndpoint> = {}): AppTabEndpoint {
  return {
    id,
    appId: "com.acme.linear",
    spaceId: "personal",
    threadId: "thread-1",
    navigate: vi.fn(async () => undefined),
    navigateForResult: vi.fn(async () => ({ accepted: true })) as never,
    invoke: vi.fn(async () => ({ updated: true })) as never,
    ...overrides,
  };
}

function broker(state: () => AppInstallationState, tabs?: Partial<AppTabHost>) {
  return new AppOperationBroker({
    installationState: state,
    mintInvocationId: () => "invocation-1",
    resolveIdentity: async () => ({ subject: "sub_test", space: "space_test" }),
    tabs: {
      open: vi.fn(async () => tab("new-tab")),
      openForResult: vi.fn(async () => ({ completed: true })) as never,
      ...tabs,
    },
  });
}

describe("AppOperationBroker", () => {
  it("activates an enabled App controller only when its first operation is invoked", async () => {
    let runtime!: AppOperationBroker;
    const ensureController = vi.fn(async () => {
      runtime.registerController({
        appId: "com.acme.linear",
        spaceId: "personal",
        handlers: { "issues.create": async () => ({ created: true }) },
      });
    });
    runtime = new AppOperationBroker({
      installationState: enabledState,
      resolveIdentity: async () => ({ subject: "sub_test", space: "space_test" }),
      ensureController,
      tabs: { open: vi.fn(), openForResult: vi.fn() },
    });

    await expect(
      runtime.invoke({
        app: "linear",
        operation: "issues.create",
        spaceId: "personal",
        threadId: "thread-1",
        input: {},
      }),
    ).resolves.toEqual({ created: true });

    expect(ensureController).toHaveBeenCalledWith("com.acme.linear", "personal");
  });

  it("keeps App slug and App-local operation key separate", async () => {
    const runtime = broker(enabledState);
    const handler = vi.fn(async (input, context) => ({
      input,
      invocation: context.invocation,
      caller: context.caller,
    }));
    runtime.registerController({
      appId: "com.acme.linear",
      spaceId: "personal",
      handlers: { "issues.create": handler },
    });

    await expect(
      runtime.invoke({
        app: "linear",
        operation: "issues.create",
        spaceId: "personal",
        threadId: "thread-1",
        input: { title: "Fix redirect" },
      }),
    ).resolves.toEqual({
      input: { title: "Fix redirect" },
      invocation: {
        id: "invocation-1",
        app: "linear",
        operation: "issues.create",
        spaceId: "personal",
        threadId: "thread-1",
      },
      caller: { kind: "host" },
    });
  });

  it("delivers only to the explicitly targeted tab", async () => {
    const runtime = broker(enabledState);
    const tabA = tab("tab-a");
    const tabB = tab("tab-b");
    runtime.registerTab(tabA);
    runtime.registerTab(tabB);
    runtime.registerController({
      appId: "com.acme.linear",
      spaceId: "personal",
      handlers: {
        "issues.create": async (_input, context) =>
          context.tab?.invoke({ operation: "selection.replace-text", input: { text: "Updated" } }),
      },
    });

    await expect(
      runtime.invoke({
        app: "linear",
        operation: "issues.create",
        spaceId: "personal",
        threadId: "thread-1",
        tabId: "tab-b",
        input: {},
      }),
    ).resolves.toEqual({ updated: true });
    expect(tabA.invoke).not.toHaveBeenCalled();
    expect(tabB.invoke).toHaveBeenCalledOnce();
  });

  it("rejects a tab outside the invocation's App, Space, or thread", async () => {
    const runtime = broker(enabledState);
    runtime.registerTab(tab("other-thread", { threadId: "thread-2" }));
    runtime.registerController({
      appId: "com.acme.linear",
      spaceId: "personal",
      handlers: { "issues.create": async () => undefined },
    });

    const invocation = runtime.invoke({
      app: "linear",
      operation: "issues.create",
      spaceId: "personal",
      threadId: "thread-1",
      tabId: "other-thread",
      input: {},
    });
    await expect(invocation).rejects.toMatchObject({
      code: "tab-target-mismatch",
    });
  });

  it("opens tabs through the host with App, Space, and thread ownership", async () => {
    const open = vi.fn(async () => tab("new-tab"));
    const runtime = broker(enabledState, { open });
    runtime.registerController({
      appId: "com.acme.linear",
      spaceId: "personal",
      handlers: {
        "issues.create": async (_input, context) => {
          await context.tabs.open({ route: "/issues/new", state: { title: "Fix redirect" } });
          return { opened: true };
        },
      },
    });

    await runtime.invoke({
      app: "linear",
      operation: "issues.create",
      spaceId: "personal",
      threadId: "thread-1",
      input: {},
    });
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        app: expect.objectContaining({ appId: "com.acme.linear", slug: "linear" }),
        spaceId: "personal",
        threadId: "thread-1",
        route: "/issues/new",
        state: { title: "Fix redirect" },
      }),
    );
  });

  it("checks installation and Space enablement at invocation time", async () => {
    let state = enabledState();
    const runtime = broker(() => state);
    runtime.registerController({
      appId: "com.acme.linear",
      spaceId: "personal",
      handlers: { "issues.create": async () => ({ created: true }) },
    });
    state = setSpaceAppEnabled(state, {
      appId: "com.acme.linear",
      spaceId: "personal",
      enabled: false,
    });

    await expect(
      runtime.invoke({
        app: "linear",
        operation: "issues.create",
        spaceId: "personal",
        threadId: "thread-1",
        input: {},
      }),
    ).rejects.toMatchObject({ code: "app-disabled" });
  });

  it("enforces declared input and output schemas at the trusted broker", async () => {
    const runtime = broker(enabledState);
    runtime.registerController({
      appId: "com.acme.linear",
      spaceId: "personal",
      handlers: { "issues.create": async () => "not-an-object" },
    });

    await expect(
      runtime.invoke({
        app: "linear",
        operation: "issues.create",
        spaceId: "personal",
        threadId: "thread-1",
        input: "not-an-object",
      }),
    ).rejects.toMatchObject({ code: "invalid-input" });

    await expect(
      runtime.invoke({
        app: "linear",
        operation: "issues.create",
        spaceId: "personal",
        threadId: "thread-1",
        input: {},
      }),
    ).rejects.toMatchObject({ code: "invalid-output" });
  });

  it("unregister callbacks cannot remove replacement endpoints", () => {
    const runtime = broker(enabledState);
    const first = tab("tab-a");
    const unregister = runtime.registerTab(first);
    unregister();
    const replacement = tab("tab-a");
    runtime.registerTab(replacement);

    unregister();
    expect(() => runtime.registerTab(tab("tab-a"))).toThrowError(
      expect.objectContaining({ code: "tab-already-registered" }),
    );
  });

  it("routes cross-App calls through the callee schema and preserves caller attribution", async () => {
    let invocation = 0;
    const runtime = new AppOperationBroker({
      installationState: crossAppState,
      mintInvocationId: () => `invocation-${++invocation}`,
      resolveIdentity: async (appId) => ({ subject: `subject:${appId}`, space: `space:${appId}` }),
      tabs: { open: vi.fn(), openForResult: vi.fn() },
    });
    runtime.registerController({
      appId: "com.acme.github",
      spaceId: "personal",
      handlers: {
        "issues.search": async (_input, context) => ({
          invocation: context.invocation,
          caller: context.caller,
        }),
      },
    });
    runtime.registerController({
      appId: "com.acme.linear",
      spaceId: "personal",
      handlers: {
        "issues.create": async (_input, context) =>
          context.operations.invoke({ app: "github", operation: "issues.search", input: {} }),
      },
    });

    await expect(
      runtime.invoke({
        app: "linear",
        operation: "issues.create",
        spaceId: "personal",
        threadId: "thread-1",
        input: {},
      }),
    ).resolves.toMatchObject({
      invocation: {
        id: "invocation-2",
        app: "github",
        operation: "issues.search",
        spaceId: "personal",
      },
      caller: { kind: "app" },
    });
  });
});
