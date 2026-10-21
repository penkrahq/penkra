import * as FS from "node:fs";
import * as Net from "node:net";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AppCommandPipeServer,
  assertAppTabAgentAddressable,
  resolveAppCommandPipePath,
  serializeFailureResponse,
} from "./appCommandPipeServer";
import { AppRuntimeFailureError } from "./appRuntimeFailure";

const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

describe("AppCommandPipeServer", () => {
  it("lists an unloaded tab's saved title and URL without opening its renderer", async () => {
    if (process.platform === "win32") return;
    const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "penkra-app-command-retained-"));
    const path = Path.join(directory, "command.sock");
    const readFolderTabs = vi.fn(async () => [
      {
        id: "saved-tab",
        kind: "app" as const,
        appId: "example.browser",
        appSpaceId: "personal",
        appSlug: "browser",
        appName: "Browser",
        appRoute: "/",
        appState: { url: "https://example.com" },
        title: "Saved example",
      },
    ]);
    const hostedPageState = vi.fn();
    const server = new AppCommandPipeServer({
      path,
      token: "secret",
      readFolderTabs,
      catalog: {} as never,
      broker: {} as never,
      observer: {} as never,
      providerCredentialVault: {} as never,
      tabs: { list: () => [], hostedPageState, current: () => null, close: vi.fn() },
      presentation: () => ({ state: "background" }),
    });
    await server.start();
    disposers.push(async () => {
      await server.dispose();
      FS.rmSync(directory, { recursive: true, force: true });
    });
    await expect(
      send(path, {
        id: "read-saved",
        token: "secret",
        method: "tabs.list",
        params: { spaceId: "personal", folderId: "folder-1", threadId: "thread-1" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      result: [
        {
          tabId: "saved-tab",
          title: "Saved example",
          url: "https://example.com",
          status: "unloaded",
          visible: false,
        },
      ],
    });
    expect(hostedPageState).not.toHaveBeenCalled();
    expect(readFolderTabs).toHaveBeenCalledWith("folder-1");
  });
  it("preserves failed-step outcomes across the command bridge", () => {
    const error = Object.assign(new Error("Activate this tab"), {
      code: "TAB_NOT_ACTIVE",
      tabId: "tab",
      failedStep: 1,
      completedSteps: [{ waited: true }],
      dispatched: false,
      outcome: "not-started",
    });
    expect(JSON.parse(serializeFailureResponse(error))).toMatchObject({
      ok: false,
      error: {
        code: "TAB_NOT_ACTIVE",
        tabId: "tab",
        failedStep: 1,
        completedSteps: [{ waited: true }],
        dispatched: false,
        outcome: "not-started",
      },
    });
  });
  it("rejects agent access to an App whose manifest disables it", () => {
    expect(() => assertAppTabAgentAddressable({ name: "Sales", agentAddressable: false })).toThrow(
      "Sales does not allow agent observation or interaction.",
    );
    expect(() => assertAppTabAgentAddressable({ name: "Base" })).not.toThrow();
  });

  it("preserves App renderer retry guidance across the command bridge", () => {
    const error = Object.assign(new Error("The App is reloading; retry after 20 seconds."), {
      code: "renderer-unavailable",
      retryable: true,
      retryAfterMs: 20_000,
    });
    expect(JSON.parse(serializeFailureResponse(error))).toMatchObject({
      ok: false,
      error: {
        code: "renderer-unavailable",
        retryable: true,
        retryAfterMs: 20_000,
      },
    });
  });

  it("preserves complete role-labelled failures across the bridge", () => {
    const message = "x".repeat(20 * 1024 * 1024);
    const serialized = serializeFailureResponse(
      new AppRuntimeFailureError({
        kind: "operation",
        message: "Update and rollback failed.",
        primary: { kind: "leaf", code: "UPDATE_FAILED", message },
        secondary: [{ role: "restore-state", failure: { kind: "leaf", message } }],
      }),
    );

    expect(Buffer.byteLength(serialized)).toBeGreaterThan(32 * 1024 * 1024);
    expect(JSON.parse(serialized)).toMatchObject({
      ok: false,
      error: {
        failure: {
          kind: "operation",
          primary: { kind: "leaf", code: "UPDATE_FAILED", message },
          secondary: [{ role: "restore-state", failure: { kind: "leaf", message } }],
        },
      },
    });
  });

  it("uses a short private Unix socket path independent of the profile path", () => {
    if (process.platform === "win32") return;
    if (!process.getuid) throw new Error("Expected getuid on Unix.");
    const path = resolveAppCommandPipePath(
      "/Users/example/Library/Application Support/penkra-development-profile-with-a-long-name",
    );

    expect(path).toMatch(
      new RegExp(`^/tmp/penkra-${process.getuid()}/app-\\d+-[a-f0-9]{12}\\.sock$`),
    );
    expect(Buffer.byteLength(path)).toBeLessThan(100);
  });

  it("authenticates, resolves the current tab, and invokes through the trusted broker", async () => {
    if (process.platform === "win32") return;
    const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "penkra-app-command-"));
    const path = Path.join(directory, "command.sock");
    const invoke = vi.fn(async () => ({ created: true }));
    const open = vi.fn(async () => ({ destination: "system" }));
    const sideload = vi.fn(async () => ({ status: "installed" }));
    const thread = vi.fn(async ({ method, value }) => ({ method, value }));
    const inheritThreadHome = vi.fn();
    const current = {
      id: "tab-1",
      rendererId: 101,
      appId: "com.acme.linear",
      slug: "linear",
      name: "Linear",
      iconDataUrl: null,
      spaceId: "personal",
      folderId: "folder-1",
      threadId: "thread-1",
      route: "/issues",
      status: "ready" as const,
      documentUrl: "penkra-app://linear/index.html#penkra-tab=tab-1",
      presentationTitle: "Issues",
    };
    const secondTab = {
      ...current,
      id: "tab-2",
      rendererId: 102,
      route: "/issues/second",
    };
    const otherThreadTab = {
      ...current,
      id: "tab-other-thread",
      rendererId: 103,
      threadId: "thread-2",
    };
    const soleSalesTab = {
      ...current,
      id: "tab-sales",
      rendererId: 104,
      appId: "com.penkra.sales",
      slug: "sales",
      name: "Sales",
    };
    const soleCanvasTab = {
      ...current,
      id: "tab-canvas",
      rendererId: 105,
      appId: "com.penkra.canvas",
      slug: "canvas",
      name: "Canvas",
      presentationTitle: null,
      threadId: "thread-2",
    };
    const snapshot = vi.fn(async () => ({ snapshot: "" }));
    const screenshot = vi.fn(async () => ({ kind: "image" }));
    const activate = vi.fn(async (tab) => ({
      tabId: tab.id,
      state: "active",
      readyForInteraction: true,
    }));
    const act = vi.fn(async () => ({ steps: [] }));
    const observedSurfaceIds: Array<number | null> = [];
    const presentationThreads: string[] = [];
    const runOnSurface = async <T>(surfaceId: number | null, operation: () => Promise<T>) => {
      observedSurfaceIds.push(surfaceId);
      return operation();
    };
    const server = new AppCommandPipeServer({
      path,
      token: "secret",
      adminToken: "admin-secret",
      readFolderTabs: async () =>
        [current, secondTab, otherThreadTab, soleSalesTab, soleCanvasTab].map((tab) => ({
          id: tab.id,
          kind: "app" as const,
          appId: tab.appId,
          appSpaceId: tab.spaceId,
          appSlug: tab.slug,
          appName: tab.name,
          appRoute: tab.route,
          ...(tab.presentationTitle === null ? {} : { title: tab.presentationTitle }),
        })),
      catalog: {
        list: vi.fn(() => [
          { slug: "linear", operations: [{ key: "issues.create", input: { type: "object" } }] },
        ]),
        help: vi.fn(async () => "Linear help\n"),
        skills: vi.fn(async () => []),
      } as never,
      broker: { invoke } as never,
      tabs: {
        list: () => [current, secondTab, otherThreadTab, soleSalesTab, soleCanvasTab],
        hostedPageState: (tabId) => ({
          page: tabId === secondTab.id ? ({ url: "https://example.test/issues" } as never) : null,
        }),
        current: () => current,
        close: vi.fn(),
        currentFor: (_spaceId, folderId, surfaceId) =>
          folderId === "folder-1" ? (surfaceId === 202 ? secondTab : current) : null,
      },
      activate,
      presentation: (tab) => ({
        state: tab.id === current.id ? "active" : "background",
      }),
      runOnThread: async (threadId, operation) => {
        presentationThreads.push(threadId);
        return operation();
      },
      observer: {
        runOnSurface,
        snapshot,
        act,
        evaluate: vi.fn(async () => ({ value: null })),
        screenshot,
        record: vi.fn(async () => ({})),
        trace: vi.fn(async () => ({})),
        har: vi.fn(async () => ({})),
      },
      providerCredentialVault: {
        store: vi.fn(async () => "provider-secret:stored"),
        issueLease: vi.fn(() => "lease.capability"),
        consumeLease: vi.fn(() => "provider-secret-value"),
        remove: vi.fn(async () => undefined),
      } as never,
      open,
      sideload,
      thread,
      inheritThreadHome,
    });
    await server.start();
    disposers.push(async () => {
      await server.dispose();
      FS.rmSync(directory, { recursive: true, force: true });
    });

    await expect(
      send(path, {
        id: "inherit-agent-denied",
        token: "secret",
        method: "thread.home.inherit",
        params: { creatorThreadId: "parent", childThreadId: "child" },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "APP_COMMAND_FORBIDDEN" } });
    expect(inheritThreadHome).not.toHaveBeenCalled();
    await expect(
      send(path, {
        id: "inherit-backend",
        token: "secret",
        adminToken: "admin-secret",
        method: "thread.home.inherit",
        params: { creatorThreadId: "parent", childThreadId: "child" },
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(inheritThreadHome).toHaveBeenCalledWith("parent", "child");
    inheritThreadHome.mockImplementationOnce(() => {
      throw new Error("inherit failed");
    });
    await expect(
      send(path, {
        id: "inherit-failed",
        token: "secret",
        adminToken: "admin-secret",
        method: "thread.home.inherit",
        params: { creatorThreadId: "parent", childThreadId: "child" },
      }),
    ).resolves.toMatchObject({ ok: false, error: { message: "inherit failed" } });

    await expect(
      send(path, {
        id: "request-1",
        token: "secret",
        method: "operations.invoke",
        params: { app: "linear", operation: "issues.create", input: { title: "Fix auth" } },
      }),
    ).resolves.toEqual({ ok: true, id: "request-1", result: { created: true } });
    expect(invoke).toHaveBeenCalledWith({
      app: "linear",
      callerKind: "agent",
      operation: "issues.create",
      input: { title: "Fix auth" },
      spaceId: "personal",
      folderId: "folder-1",
      threadId: "thread-1",
      signal: expect.any(AbortSignal),
    });

    await expect(
      send(path, {
        id: "request-explicit-folder-tab",
        token: "secret",
        method: "operations.invoke",
        params: {
          app: "linear",
          operation: "issues.create",
          input: {},
          spaceId: "personal",
          folderId: "folder-1",
          threadId: "thread-1",
          tabId: "tab-other-thread",
        },
      }),
    ).resolves.toEqual({
      ok: true,
      id: "request-explicit-folder-tab",
      result: { created: true },
    });

    await expect(
      send(path, {
        id: "request-sole-app-tab",
        token: "secret",
        method: "operations.invoke",
        params: {
          app: "sales",
          operation: "whatsapp.send",
          input: { phone: "+13073461585", text: "Hello" },
          spaceId: "personal",
          folderId: "folder-1",
          threadId: "thread-1",
        },
      }),
    ).resolves.toEqual({ ok: true, id: "request-sole-app-tab", result: { created: true } });
    expect(invoke).toHaveBeenLastCalledWith({
      app: "sales",
      callerKind: "agent",
      operation: "whatsapp.send",
      input: { phone: "+13073461585", text: "Hello" },
      spaceId: "personal",
      folderId: "folder-1",
      threadId: "thread-1",
      signal: expect.any(AbortSignal),
    });

    await expect(
      send(path, {
        id: "request-folder-canvas-tab",
        token: "secret",
        method: "operations.invoke",
        params: {
          app: "canvas",
          operation: "documents.execute",
          input: { id: "document-1" },
          spaceId: "personal",
          folderId: "folder-1",
          threadId: "thread-1",
        },
      }),
    ).resolves.toEqual({
      ok: true,
      id: "request-folder-canvas-tab",
      result: { created: true },
    });
    expect(invoke).toHaveBeenLastCalledWith({
      app: "canvas",
      callerKind: "agent",
      operation: "documents.execute",
      input: { id: "document-1" },
      spaceId: "personal",
      folderId: "folder-1",
      threadId: "thread-1",
      signal: expect.any(AbortSignal),
    });

    await expect(
      send(path, {
        id: "request-open",
        token: "secret",
        method: "core.open",
        params: {
          path: "/tmp/example.pdf",
          requestedApp: "explorer",
          spaceId: "personal",
          folderId: "folder-1",
          threadId: "thread-1",
        },
      }),
    ).resolves.toEqual({
      ok: true,
      id: "request-open",
      result: { destination: "system" },
    });
    expect(open).toHaveBeenCalledWith({
      path: "/tmp/example.pdf",
      requestedApp: "explorer",
      spaceId: "personal",
      folderId: "folder-1",
      threadId: "thread-1",
    });
    expect(presentationThreads).toContain("thread-1");

    await expect(
      send(path, {
        id: "request-sideload",
        token: "secret",
        method: "developer.sideload",
        params: { sourcePath: "/work/canvas/dist", spaceId: "personal" },
      }),
    ).resolves.toEqual({
      ok: true,
      id: "request-sideload",
      result: { status: "installed" },
    });
    expect(sideload).toHaveBeenCalledWith({
      sourcePath: "/work/canvas/dist",
      spaceId: "personal",
    });

    await expect(
      send(path, {
        id: "request-thread-compose",
        token: "secret",
        method: "threads.compose",
        params: {
          spaceId: "personal",
          folderId: "folder-1",
          threadId: "thread-1",
          input: { text: "Attend to new messages" },
        },
      }),
    ).resolves.toEqual({
      ok: true,
      id: "request-thread-compose",
      result: { method: "compose", value: { text: "Attend to new messages" } },
    });
    expect(thread).toHaveBeenCalledWith({
      spaceId: "personal",
      folderId: "folder-1",
      threadId: "thread-1",
      method: "compose",
      value: { text: "Attend to new messages" },
    });

    await expect(
      send(path, {
        id: "request-tabs",
        token: "secret",
        method: "tabs.list",
        params: { spaceId: "personal", folderId: "folder-1", threadId: "thread-1" },
      }),
    ).resolves.toEqual({
      ok: true,
      id: "request-tabs",
      result: [current, secondTab, otherThreadTab, soleSalesTab, soleCanvasTab].map((tab) => ({
        tabId: tab.id,
        appId: tab.appId,
        appName: tab.name,
        title: tab.id === soleCanvasTab.id ? "Canvas" : "Issues",
        status: "ready",
        visible: tab.id === current.id,
        ...(tab.id === secondTab.id ? { url: "https://example.test/issues" } : {}),
      })),
    });

    await expect(
      send(path, {
        id: "request-tabs-other-thread",
        token: "secret",
        method: "tabs.list",
        params: { spaceId: "personal", folderId: "folder-1", threadId: "thread-2" },
      }),
    ).resolves.toEqual({
      ok: true,
      id: "request-tabs-other-thread",
      result: [current, secondTab, otherThreadTab, soleSalesTab, soleCanvasTab].map((tab) => ({
        tabId: tab.id,
        appId: tab.appId,
        appName: tab.name,
        title: tab.id === soleCanvasTab.id ? "Canvas" : "Issues",
        status: "ready",
        visible: tab.id === current.id,
        ...(tab.id === secondTab.id ? { url: "https://example.test/issues" } : {}),
      })),
    });

    await expect(
      send(path, {
        id: "request-exact-second-tab",
        token: "secret",
        method: "tabs.snapshot",
        params: {
          spaceId: "personal",
          folderId: "folder-1",
          threadId: "thread-1",
          tabId: "tab-2",
        },
      }),
    ).resolves.toEqual({
      ok: true,
      id: "request-exact-second-tab",
      result: { snapshot: "" },
    });
    expect(snapshot).toHaveBeenCalledWith("tab-2", {
      document: "d1",
    });

    await expect(
      send(path, {
        id: "request-cross-thread-tab",
        token: "secret",
        method: "tabs.snapshot",
        params: {
          spaceId: "personal",
          folderId: "folder-1",
          threadId: "thread-1",
          tabId: "tab-other-thread",
        },
      }),
    ).resolves.toEqual({
      ok: true,
      id: "request-cross-thread-tab",
      result: { snapshot: "" },
    });
    expect(snapshot).toHaveBeenCalledTimes(2);

    await expect(
      send(path, {
        id: "request-act",
        token: "secret",
        method: "tabs.act",
        params: {
          spaceId: "personal",
          folderId: "folder-1",
          threadId: "thread-1",
          tabId: "tab-other-thread",
          steps: [{ action: "press", document: "d1", key: "Escape" }],
        },
      }),
    ).resolves.toEqual({
      ok: true,
      id: "request-act",
      result: { steps: [] },
    });
    expect(act).toHaveBeenCalledWith(
      "tab-other-thread",
      [{ action: "press", document: "d1", key: "Escape" }],
      false,
      "thread-1",
      expect.any(AbortSignal),
    );

    await expect(
      send(path, {
        id: "activate",
        token: "secret",
        method: "tabs.activate",
        params: {
          spaceId: current.spaceId,
          folderId: "folder-1",
          threadId: "thread-1",
          tabId: current.id,
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      result: { tabId: current.id, state: "active", readyForInteraction: true },
    });
    expect(activate).toHaveBeenCalledWith(current, "thread-1", expect.any(AbortSignal));
    await expect(
      send(path, {
        id: "activate-outside",
        token: "secret",
        method: "tabs.activate",
        params: {
          spaceId: "space-other",
          folderId: "folder-1",
          threadId: "thread-1",
          tabId: current.id,
        },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "TAB_GONE" } });
    expect(activate).toHaveBeenCalledOnce();

    await expect(
      send(path, {
        id: "request-visible-screenshot",
        token: "secret",
        method: "tabs.screenshot",
        params: {
          spaceId: "personal",
          folderId: "folder-1",
          threadId: "thread-1",
          tabId: "tab-1",
          document: "d1",
        },
      }),
    ).resolves.toEqual({
      ok: true,
      id: "request-visible-screenshot",
      result: { kind: "image" },
    });
    expect(screenshot).toHaveBeenCalledWith("tab-1", "d1", undefined);
    expect(activate).toHaveBeenCalledTimes(2);
    activate.mockRejectedValueOnce(
      Object.assign(new Error('Folder "Work" is not open.'), {
        code: "FOLDER_NOT_OPEN",
        dispatched: false,
      }),
    );
    await expect(
      send(path, {
        id: "unavailable-folder-screenshot",
        token: "secret",
        method: "tabs.screenshot",
        params: { spaceId: "personal", folderId: "folder-1", threadId: "thread-1", tabId: "tab-1" },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "FOLDER_NOT_OPEN" } });
    expect(screenshot).toHaveBeenCalledOnce();

    await expect(
      send(path, {
        id: "request-origin-snapshot",
        token: "secret",
        method: "tabs.snapshot",
        params: {
          spaceId: "personal",
          folderId: "folder-1",
          threadId: "thread-1",
          tabId: "tab-2",
          callerTurnId: "turn-origin",
        },
      }),
    ).resolves.toEqual({
      ok: true,
      id: "request-origin-snapshot",
      result: { snapshot: "" },
    });
    expect(observedSurfaceIds.at(-1)).toBeNull();

    await expect(
      send(path, {
        id: "request-unbound-operation",
        token: "secret",
        method: "operations.invoke",
        params: {
          app: "linear",
          operation: "issues.create",
          input: {},
          spaceId: "personal",
          folderId: "folder-1",
          threadId: "thread-2",
          callerTurnId: "turn-unbound",
        },
      }),
    ).resolves.toEqual({
      ok: true,
      id: "request-unbound-operation",
      result: { created: true },
    });
    expect(observedSurfaceIds.at(-1)).toBeNull();

    await expect(
      send(path, {
        id: "request-unbound-snapshot",
        token: "secret",
        method: "tabs.snapshot",
        params: {
          spaceId: "personal",
          folderId: "folder-1",
          threadId: "thread-2",
          tabId: "tab-1",
          callerTurnId: "turn-unbound",
        },
      }),
    ).resolves.toEqual({
      ok: true,
      id: "request-unbound-snapshot",
      result: { snapshot: "" },
    });

    await expect(
      send(path, {
        id: "request-closed-origin-operation",
        token: "secret",
        method: "operations.invoke",
        params: {
          app: "canvas",
          operation: "documents.execute",
          input: { id: "document-1" },
          spaceId: "personal",
          folderId: "folder-1",
          threadId: "thread-2",
          tabId: "tab-canvas",
          callerTurnId: "turn-closed",
        },
      }),
    ).resolves.toEqual({
      ok: true,
      id: "request-closed-origin-operation",
      result: { created: true },
    });

    await expect(
      send(path, {
        id: "request-closed-origin-snapshot",
        token: "secret",
        method: "tabs.snapshot",
        params: {
          spaceId: "personal",
          folderId: "folder-1",
          threadId: "thread-2",
          tabId: "tab-canvas",
          callerTurnId: "turn-closed",
        },
      }),
    ).resolves.toEqual({
      ok: true,
      id: "request-closed-origin-snapshot",
      result: { snapshot: "" },
    });

    await expect(
      send(path, {
        id: "request-origin-thread-select",
        token: "secret",
        method: "threads.select",
        params: {
          spaceId: "personal",
          folderId: "folder-1",
          threadId: "thread-1",
          callerTurnId: "turn-origin",
          input: { threadId: "thread-2" },
        },
      }),
    ).resolves.toEqual({
      ok: true,
      id: "request-origin-thread-select",
      result: { method: "select", value: { threadId: "thread-2" } },
    });
    expect(thread).toHaveBeenLastCalledWith({
      spaceId: "personal",
      folderId: "folder-1",
      threadId: "thread-1",
      method: "select",
      value: { threadId: "thread-2" },
    });

    await expect(
      send(path, {
        id: "request-unbound-shell-action",
        token: "secret",
        method: "threads.select",
        params: {
          spaceId: "personal",
          folderId: "folder-1",
          threadId: "thread-1",
          input: { threadId: "thread-2" },
        },
      }),
    ).resolves.toMatchObject({ ok: true });

    await expect(
      send(path, {
        id: "request-closed-shell-action",
        token: "secret",
        method: "threads.select",
        params: {
          spaceId: "personal",
          folderId: "folder-1",
          threadId: "thread-1",
          callerTurnId: "turn-closed",
          input: { threadId: "thread-2" },
        },
      }),
    ).resolves.toMatchObject({ ok: true });

    await expect(
      send(path, {
        id: "request-2",
        token: "wrong",
        method: "tabs.list",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "APP_COMMAND_FAILED", message: "Invalid App command capability." },
    });
  });

  it("aborts an in-flight App operation when its command caller disconnects", async () => {
    if (process.platform === "win32") return;
    const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "penkra-app-command-abort-"));
    const path = Path.join(directory, "command.sock");
    let operationSignal: AbortSignal | undefined;
    let resolveAborted!: () => void;
    const observedAbort = new Promise<void>((resolve) => {
      resolveAborted = resolve;
    });
    const invoke = vi.fn(async (input: { signal: AbortSignal }) => {
      operationSignal = input.signal;
      await new Promise<never>((_resolve, reject) => {
        input.signal.addEventListener(
          "abort",
          () => {
            resolveAborted();
            reject(input.signal.reason);
          },
          { once: true },
        );
      });
    });
    const current = {
      id: "tab-1",
      rendererId: 101,
      appId: "com.acme.linear",
      slug: "linear",
      name: "Linear",
      iconDataUrl: null,
      spaceId: "personal",
      folderId: "folder-1",
      threadId: "thread-1",
      route: "/",
      status: "ready" as const,
      documentUrl: "penkra-app://linear/app.html",
    };
    const server = new AppCommandPipeServer({
      path,
      token: "secret",
      readFolderTabs: async () => [],
      catalog: {} as never,
      broker: { invoke } as never,
      tabs: {
        list: () => [current],
        current: () => current,
        close: vi.fn(),
        hostedPageState: () => ({ page: null }),
      },
      presentation: () => ({ state: "background" }),
      observer: {} as never,
      providerCredentialVault: {} as never,
    });
    await server.start();
    disposers.push(async () => {
      await server.dispose();
      FS.rmSync(directory, { recursive: true, force: true });
    });

    const socket = Net.createConnection(path);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => {
        socket.write(
          `${JSON.stringify({
            id: "request-abort",
            token: "secret",
            method: "operations.invoke",
            params: { app: "linear", operation: "issues.create", input: {} },
          })}\n`,
        );
        resolve();
      });
      socket.once("error", reject);
    });
    await vi.waitFor(() => expect(operationSignal).toBeInstanceOf(AbortSignal));
    socket.destroy();
    await observedAbort;

    expect(operationSignal?.aborted).toBe(true);
  });
});

function send(path: string, request: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = Net.createConnection(path);
    let response = "";
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
    });
    socket.once("end", () => {
      try {
        resolve(JSON.parse(response));
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}
