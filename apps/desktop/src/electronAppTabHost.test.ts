import { describe, expect, it, vi } from "vitest";

const TEST_ORIGIN = `penkra-app://a-${"a".repeat(64)}`;

import type { InstalledAppPackage } from "./appInstallationState";
import { ElectronAppTabHost, shouldNotifyAppTabClosed } from "./electronAppTabHost";

function installedApp(): InstalledAppPackage {
  const manifest = {
    id: "com.penkra.apps",
    slug: "apps",
    name: "Apps",
    summary: "Discover and manage Apps.",
    version: "0.1.0",
    compatibility: { penkra: ">=0.8.0" },
    icons: [{ src: "assets/icon.svg", sizes: "any", type: "image/svg+xml" }],
    entrypoints: { tab: "app.html", controller: "operations.js" },
  } as const;
  return {
    appId: manifest.id,
    slug: manifest.slug,
    name: manifest.name,
    summary: manifest.summary,
    version: manifest.version,
    source: "registry",
    packagePath: "/profile/apps/com.penkra.apps/0.1.0",
    sha256: "a".repeat(64),
    installedAt: "2026-08-01T00:00:00.000Z",
    manifest,
  };
}

function createRpcMock() {
  return {
    registerTarget: vi.fn(() => vi.fn()),
    request: vi.fn(),
    acceptResponse: vi.fn(),
    acceptContextCall: vi.fn(),
  };
}

describe("ElectronAppTabHost", () => {
  it("preserves persisted shell panes while the host stops or replaces an App", () => {
    expect(shouldNotifyAppTabClosed("host-stopped")).toBe(false);
    expect(shouldNotifyAppTabClosed("app-updated")).toBe(false);
    expect(shouldNotifyAppTabClosed("tab-closed")).toBe(true);
    expect(shouldNotifyAppTabClosed("app-disabled")).toBe(true);
    expect(shouldNotifyAppTabClosed("app-uninstalled")).toBe(true);
  });

  it("owns one DOM-frame capability identity without creating a native visual view", async () => {
    const app = installedApp();
    const unregisterBroker = vi.fn();
    const unregisterRpc = vi.fn();
    const releaseIdentity = vi.fn();
    const registerRendererIdentity = vi.fn(() => releaseIdentity);
    const onOpened = vi.fn();
    const onState = vi.fn();
    const onClosed = vi.fn();
    const onFrameHostMessage = vi.fn();
    const host = new ElectronAppTabHost({
      installations: {
        snapshot: () => ({
          packagesByInstallationKey: { [`personal\0${app.appId}`]: app },
        }),
        isActive: () => true,
        setEnabled: vi.fn(),
      } as never,
      sessions: {
        get: () => ({ appId: app.appId, spaceId: "personal", origin: TEST_ORIGIN }) as never,
      },
      frameDocuments: { activate: async () => `/app.html` },
      broker: { registerTab: vi.fn(() => unregisterBroker) },
      rpc: { ...createRpcMock(), registerTarget: vi.fn(() => unregisterRpc) },
      ipcBridge: { waitForReady: vi.fn() },
      onOpened,
      onState,
      onClosed,
      onFrameHostMessage,
      registerRendererIdentity,
    });

    const descriptor = await host.openInstalled({
      appId: app.appId,
      spaceId: "personal",
      threadId: "thread-1",
      route: "/",
    });

    expect(onOpened).toHaveBeenCalledWith(
      expect.objectContaining({ appId: app.appId, iconDataUrl: null, status: "loading" }),
    );
    host.setZoomFactor(0.8);

    expect(descriptor).toMatchObject({
      appId: app.appId,
      spaceId: "personal",
      threadId: "thread-1",
      status: "loading",
      rendererId: -1,
      documentUrl: expect.stringMatching(/^\/app\.html\?penkra-renderer=-1#penkra-tab=/),
    });
    expect(host.list()).toEqual([descriptor]);
    expect(host.has(descriptor.id)).toBe(true);
    expect(host.current()).toBeNull();
    onOpened.mockClear();
    host.present(descriptor.id);
    expect(onOpened).toHaveBeenCalledWith(descriptor);
    expect(onState).not.toHaveBeenCalled();
    expect(registerRendererIdentity).toHaveBeenCalledWith({
      appId: app.appId,
      spaceId: "personal",
      tabId: descriptor.id,
      threadId: "thread-1",
      rendererId: -1,
    });
    host.markFrameReady(descriptor.id, descriptor.rendererId);
    expect(host.list()[0]).toMatchObject({ status: "ready" });
    expect(onFrameHostMessage).toHaveBeenCalledWith({
      tabId: descriptor.id,
      rendererId: descriptor.rendererId,
      delivery: { kind: "event", name: "appearance.zoom", payload: 0.8 },
    });

    host.setActive(descriptor.id, descriptor.rendererId, true);
    expect(host.current()).toMatchObject({ ...descriptor, status: "ready" });
    host.setActive(descriptor.id, descriptor.rendererId, false);
    expect(host.current()).toBeNull();

    await host.navigate(descriptor.id, { route: "/document/7", state: { page: 3 } });
    expect(host.captureForUpdate(app.appId, "personal")).toEqual([
      { id: descriptor.id, threadId: "thread-1", route: "/document/7", state: { page: 3 } },
    ]);

    host.setRoute(descriptor.id, { route: "/document/8", state: { page: 4 } });
    expect(host.captureForUpdate(app.appId, "personal")).toEqual([
      { id: descriptor.id, threadId: "thread-1", route: "/document/8", state: { page: 4 } },
    ]);

    host.closeForAppSpace(app.appId, "personal");
    host.close(descriptor.id);
    expect(host.has(descriptor.id)).toBe(false);
    expect(unregisterBroker).toHaveBeenCalledOnce();
    expect(unregisterRpc).toHaveBeenCalledWith("app-disabled");
    expect(releaseIdentity).toHaveBeenCalledOnce();
    expect(onClosed).toHaveBeenCalledWith({ id: descriptor.id, threadId: "thread-1" });
    expect(host.list()).toEqual([]);
  });

  it("restores an updated App with the same tab identity", async () => {
    const app = installedApp();
    const attachedViews = new Set<unknown>();
    const retireGeneration = vi.fn();
    const retireTab = vi.fn();
    const host = new ElectronAppTabHost({
      installations: {
        snapshot: () => ({
          packagesByInstallationKey: { [`personal\0${app.appId}`]: app },
        }),
        isActive: () => true,
        setEnabled: vi.fn(),
      } as never,
      sessions: {
        get: () => ({ appId: app.appId, spaceId: "personal", origin: TEST_ORIGIN }) as never,
      },
      frameDocuments: { activate: async () => `/app.html` },
      broker: { registerTab: vi.fn(() => vi.fn()) },
      rpc: createRpcMock(),
      ipcBridge: { waitForReady: vi.fn(async () => undefined) },
      onOpened: vi.fn(),
      onState: vi.fn(),
      authority: { retireGeneration, retireTab },
    });

    const original = await host.openInstalled({
      appId: app.appId,
      spaceId: "personal",
      threadId: "thread-1",
      route: "/document/7",
      state: { page: 3 },
    });
    const snapshot = host.captureForUpdate(app.appId, "personal");
    host.setActive(original.id, original.rendererId, true);
    expect(attachedViews).toEqual(new Set());

    host.closeForAppSpace(app.appId, "personal", "app-updated");
    expect(retireGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: original.id, rendererId: original.rendererId }),
    );
    expect(retireTab).not.toHaveBeenCalled();
    await host.restoreAfterUpdate(app.appId, "personal", snapshot);

    const restored = host.list()[0];
    expect(restored).toBeDefined();
    if (!restored) throw new Error("Updated App tab was not restored.");
    expect(restored.rendererId).not.toBe(original.rendererId);
    expect(restored.documentUrl).not.toBe(original.documentUrl);
    expect(restored.documentUrl).toContain(`penkra-renderer=${restored.rendererId}`);
    expect(host.setActive(restored.id, restored.rendererId, true)).toBe(true);

    // Cleanup from the retired React effect must not hide or resize the replacement renderer.
    expect(host.setActive(original.id, original.rendererId, false)).toBe(false);
    expect(attachedViews).toEqual(new Set());

    expect(host.list()).toEqual([
      expect.objectContaining({
        id: original.id,
        rendererId: restored.rendererId,
        appId: app.appId,
        threadId: "thread-1",
        route: "/document/7",
        status: "loading",
      }),
    ]);
  });

  it("does not block an App update on navigation for an unmounted background tab", async () => {
    const app = installedApp();
    const rpc = createRpcMock();
    rpc.request.mockReturnValue(new Promise(() => undefined));
    const host = new ElectronAppTabHost({
      installations: {
        snapshot: () => ({ packagesByInstallationKey: { [`personal\0${app.appId}`]: app } }),
        isActive: () => true,
        setEnabled: vi.fn(),
      } as never,
      sessions: {
        get: () => ({ appId: app.appId, spaceId: "personal", origin: TEST_ORIGIN }) as never,
      },
      frameDocuments: { activate: async () => "/app.html" },
      broker: { registerTab: vi.fn(() => vi.fn()) },
      rpc,
      ipcBridge: { waitForReady: vi.fn(async () => undefined) },
      onOpened: vi.fn(),
      onState: vi.fn(),
    });

    await expect(
      host.restoreAfterUpdate(app.appId, "personal", [
        {
          id: "background-tab",
          threadId: "background-thread",
          route: "/document/7",
          state: { page: 3 },
        },
      ]),
    ).resolves.toBeUndefined();

    expect(host.list()).toEqual([
      expect.objectContaining({ id: "background-tab", route: "/document/7", status: "loading" }),
    ]);
    expect(rpc.request).toHaveBeenCalledWith(-1, "tab.navigate", {
      route: "/document/7",
      state: { page: 3 },
    });
  });

  it("retires and diagnoses only failed restored panes while preserving successful siblings", async () => {
    const app = installedApp();
    const retireTab = vi.fn();
    const onClosed = vi.fn();
    const onDiagnostic = vi.fn();
    const resolveIconDataUrl = vi
      .fn<() => Promise<string | null>>()
      .mockRejectedValueOnce(new Error("first icon failed"))
      .mockResolvedValue(null);
    const host = new ElectronAppTabHost({
      installations: {
        snapshot: () => ({ packagesByInstallationKey: { [`personal\0${app.appId}`]: app } }),
        isActive: () => true,
        setEnabled: vi.fn(),
      } as never,
      sessions: {
        get: () => ({ appId: app.appId, spaceId: "personal", origin: TEST_ORIGIN }) as never,
      },
      frameDocuments: { activate: async () => "/app.html" },
      broker: { registerTab: vi.fn(() => vi.fn()) },
      rpc: createRpcMock(),
      ipcBridge: { waitForReady: vi.fn(async () => undefined) },
      onOpened: vi.fn(),
      onState: vi.fn(),
      onClosed,
      onDiagnostic,
      resolveIconDataUrl,
      authority: { retireGeneration: vi.fn(), retireTab },
    });

    await host.restoreAfterUpdate(app.appId, "personal", [
      { id: "failed-tab", threadId: "thread-1", route: "/" },
      { id: "working-tab", threadId: "thread-1", route: "/" },
    ]);

    expect(host.has("failed-tab")).toBe(false);
    expect(host.has("working-tab")).toBe(true);
    expect(retireTab).toHaveBeenCalledWith({
      appId: app.appId,
      spaceId: "personal",
      threadId: "thread-1",
      tabId: "failed-tab",
    });
    expect(onClosed).toHaveBeenCalledWith({ id: "failed-tab", threadId: "thread-1" });
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "tab-navigation-restore-failed",
        tabId: "failed-tab",
        failure: expect.objectContaining({ kind: "operation" }),
      }),
    );
    await expect(
      host.openInstalled({
        tabId: "failed-tab",
        appId: app.appId,
        spaceId: "personal",
        threadId: "thread-1",
        route: "/",
      }),
    ).resolves.toMatchObject({ id: "failed-tab" });
  });

  it("does not let a retired generation's delayed navigation failure close its replacement", async () => {
    const app = installedApp();
    let rejectOldNavigation!: (error: Error) => void;
    const rpc = createRpcMock();
    rpc.request
      .mockImplementationOnce(
        () => new Promise<void>((_resolve, reject) => (rejectOldNavigation = reject)),
      )
      .mockResolvedValue(undefined);
    const host = new ElectronAppTabHost({
      installations: {
        snapshot: () => ({ packagesByInstallationKey: { [`personal\0${app.appId}`]: app } }),
        isActive: () => true,
        setEnabled: vi.fn(),
      } as never,
      sessions: {
        get: () => ({ appId: app.appId, spaceId: "personal", origin: TEST_ORIGIN }) as never,
      },
      frameDocuments: { activate: async () => "/app.html" },
      broker: { registerTab: vi.fn(() => vi.fn()) },
      rpc,
      ipcBridge: { waitForReady: vi.fn(async () => undefined) },
      onOpened: vi.fn(),
      onState: vi.fn(),
    });
    const snapshot = [{ id: "stable-tab", threadId: "thread-1", route: "/document/7" }];

    await host.restoreAfterUpdate(app.appId, "personal", snapshot);
    const oldRendererId = host.rendererId("stable-tab");
    host.closeForAppSpace(app.appId, "personal", "app-updated");
    await host.restoreAfterUpdate(app.appId, "personal", snapshot);
    const replacementRendererId = host.rendererId("stable-tab");
    expect(replacementRendererId).not.toBe(oldRendererId);

    rejectOldNavigation(new Error("late failure from retired generation"));
    await Promise.resolve();
    expect(host.has("stable-tab")).toBe(true);
    expect(host.rendererId("stable-tab")).toBe(replacementRendererId);
  });

  it("unwinds partial registration when creation fails after renderer identity registration", async () => {
    const app = installedApp();
    const releaseIdentity = vi.fn();
    const registerRendererIdentity = vi.fn(() => releaseIdentity);
    const registerTarget = vi.fn();
    const registerTab = vi.fn();
    const host = new ElectronAppTabHost({
      installations: {
        snapshot: () => ({ packagesByInstallationKey: { [`personal\0${app.appId}`]: app } }),
        isActive: () => true,
        setEnabled: vi.fn(),
      } as never,
      sessions: {
        get: () => ({ appId: app.appId, spaceId: "personal", origin: TEST_ORIGIN }) as never,
      },
      frameDocuments: { activate: async () => "/app.html" },
      broker: { registerTab },
      rpc: { ...createRpcMock(), registerTarget },
      ipcBridge: { waitForReady: vi.fn(async () => undefined) },
      onOpened: vi.fn(),
      onState: vi.fn(),
      registerRendererIdentity,
      resolveIconDataUrl: async () => {
        throw new Error("icon read failed");
      },
    });

    await expect(
      host.openInstalled({
        appId: app.appId,
        spaceId: "personal",
        threadId: "thread-1",
        route: "/",
      }),
    ).rejects.toMatchObject({
      failure: {
        kind: "operation",
        primary: { kind: "leaf", message: "icon read failed" },
      },
    });
    expect(releaseIdentity).toHaveBeenCalledOnce();
    expect(registerTarget).not.toHaveBeenCalled();
    expect(registerTab).not.toHaveBeenCalled();
    expect(host.list()).toEqual([]);
  });

  it("continues construction rollback when one disposer fails and labels the cleanup failure", async () => {
    const app = installedApp();
    const releaseIdentity = vi.fn();
    const unregisterRpc = vi.fn(() => {
      throw new Error("RPC detach failed");
    });
    const host = new ElectronAppTabHost({
      installations: {
        snapshot: () => ({ packagesByInstallationKey: { [`personal\0${app.appId}`]: app } }),
        isActive: () => true,
        setEnabled: vi.fn(),
      } as never,
      sessions: {
        get: () => ({ appId: app.appId, spaceId: "personal", origin: TEST_ORIGIN }) as never,
      },
      frameDocuments: { activate: async () => "/app.html" },
      broker: {
        registerTab: () => {
          throw new Error("broker registration failed");
        },
      },
      rpc: { ...createRpcMock(), registerTarget: vi.fn(() => unregisterRpc) },
      ipcBridge: { waitForReady: vi.fn(async () => undefined) },
      onOpened: vi.fn(),
      onState: vi.fn(),
      registerRendererIdentity: vi.fn(() => releaseIdentity),
      resolveIconDataUrl: async () => null,
    });

    await expect(
      host.openInstalled({
        appId: app.appId,
        spaceId: "personal",
        threadId: "thread-1",
        route: "/",
      }),
    ).rejects.toMatchObject({
      failure: {
        kind: "operation",
        primary: { message: "broker registration failed" },
        secondary: [{ role: "renderer-rpc", failure: { message: "RPC detach failed" } }],
      },
    });
    expect(unregisterRpc).toHaveBeenCalledOnce();
    expect(releaseIdentity).toHaveBeenCalledOnce();
    expect(host.list()).toEqual([]);
  });

  it("replays complete navigation when an existing tab frame reconnects", async () => {
    const app = installedApp();
    const rpc = createRpcMock();
    rpc.request.mockResolvedValue(undefined);
    const onDiagnostic = vi.fn();
    const host = new ElectronAppTabHost({
      installations: {
        snapshot: () => ({
          packagesByInstallationKey: { [`personal\0${app.appId}`]: app },
        }),
        isActive: () => true,
        setEnabled: vi.fn(),
      } as never,
      sessions: {
        get: () => ({ appId: app.appId, spaceId: "personal", origin: TEST_ORIGIN }) as never,
      },
      frameDocuments: { activate: async () => `/app.html` },
      broker: { registerTab: vi.fn(() => vi.fn()) },
      rpc,
      ipcBridge: { waitForReady: vi.fn(async () => undefined) },
      onOpened: vi.fn(),
      onState: vi.fn(),
      onDiagnostic,
    });

    const descriptor = await host.openInstalled({
      appId: app.appId,
      spaceId: "personal",
      threadId: "thread-1",
      route: "/document",
      state: { documentId: "doc-1", viewport: { x: 20, y: 40 } },
    });
    expect(descriptor.state).toEqual({ documentId: "doc-1", viewport: { x: 20, y: 40 } });
    rpc.request.mockClear();

    host.markFrameReady(descriptor.id, descriptor.rendererId);
    expect(rpc.request).not.toHaveBeenCalled();
    host.markFrameReady(descriptor.id, descriptor.rendererId);

    expect(rpc.request).toHaveBeenCalledWith(descriptor.rendererId, "tab.navigate", {
      route: "/document",
      state: { documentId: "doc-1", viewport: { x: 20, y: 40 } },
    });
    await vi.waitFor(() =>
      expect(onDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "tab-navigation-restored",
          tabId: descriptor.id,
          message: "/document",
        }),
      ),
    );
  });

  it("lazily activates a persisted enabled App before opening its UI", async () => {
    const base = installedApp();
    const app: InstalledAppPackage = {
      ...base,
      appId: "com.penkra.browser",
      slug: "browser",
      name: "Browser",
      packagePath: "/profile/apps/com.penkra.browser/0.1.0",
      manifest: {
        ...base.manifest,
        id: "com.penkra.browser",
        slug: "browser",
        name: "Browser",
      },
    };
    const ensureActive = vi.fn(async () => undefined);
    const host = new ElectronAppTabHost({
      installations: {
        snapshot: () => ({
          packagesByInstallationKey: { [`personal\0${app.appId}`]: app },
        }),
        isActive: () => false,
        ensureActive,
        setEnabled: vi.fn(),
      } as never,
      sessions: {
        get: () => ({ appId: app.appId, spaceId: "personal", origin: TEST_ORIGIN }) as never,
      },
      frameDocuments: { activate: async () => `/app.html` },
      broker: { registerTab: vi.fn(() => vi.fn()) },
      rpc: createRpcMock(),
      ipcBridge: { waitForReady: vi.fn(async () => undefined) },
      onOpened: vi.fn(),
      onState: vi.fn(),
    });

    await expect(
      host.openInstalled({
        appId: app.appId,
        spaceId: "personal",
        threadId: "thread-1",
        route: "/",
      }),
    ).resolves.toMatchObject({ appId: app.appId, status: "loading" });
    expect(ensureActive).toHaveBeenCalledWith(app.appId, "personal");
  });

  it("opens an installed App in the calling Apps tab context", async () => {
    const apps = installedApp();
    const target: InstalledAppPackage = {
      ...apps,
      appId: "com.example.canvas",
      slug: "canvas",
      name: "Canvas",
      summary: "Edit a canvas.",
      packagePath: "/profile/apps/com.example.canvas/0.1.0",
      manifest: {
        ...apps.manifest,
        id: "com.example.canvas",
        slug: "canvas",
        name: "Canvas",
        summary: "Edit a canvas.",
      },
    };
    const registerRendererIdentity = vi.fn(
      (_input: { appId: string; spaceId: string; rendererId: number }) => vi.fn(),
    );
    const host = new ElectronAppTabHost({
      installations: {
        snapshot: () => ({
          packagesByInstallationKey: {
            [`personal\0${apps.appId}`]: apps,
            [`personal\0${target.appId}`]: target,
          },
        }),
        isActive: () => true,
        setEnabled: vi.fn(),
      } as never,
      sessions: {
        get: (appId: string, spaceId: string) => ({ appId, spaceId, origin: TEST_ORIGIN }) as never,
      },
      frameDocuments: { activate: async () => `/app.html` },
      broker: { registerTab: vi.fn(() => vi.fn()) },
      rpc: createRpcMock(),
      ipcBridge: { waitForReady: vi.fn(async () => undefined) },
      onOpened: vi.fn(),
      onState: vi.fn(),
      registerRendererIdentity,
    });

    await host.openInstalled({
      appId: apps.appId,
      spaceId: "personal",
      threadId: "thread-1",
      route: "/",
    });
    const renderer = registerRendererIdentity.mock.calls[0]?.[0];
    expect(renderer).toBeDefined();
    if (!renderer) throw new Error("Apps renderer was not registered.");
    const descriptor = await host.openInstalledFromRenderer(renderer.rendererId, {
      appId: target.appId,
    });

    expect(descriptor).toMatchObject({
      appId: target.appId,
      spaceId: "personal",
      threadId: "thread-1",
      route: "/",
      status: "loading",
    });
    await expect(host.openInstalledFromRenderer(999, { appId: target.appId })).rejects.toThrow(
      "originating App tab is unavailable",
    );
  });

  it("delivers Theme and Typography as independent frame events after readiness", async () => {
    const app = installedApp();
    const onFrameHostMessage = vi.fn();
    const host = new ElectronAppTabHost({
      installations: {
        snapshot: () => ({
          packagesByInstallationKey: { [`personal\0${app.appId}`]: app },
        }),
        isActive: () => true,
        setEnabled: vi.fn(),
      } as never,
      sessions: {
        get: () => ({ appId: app.appId, spaceId: "personal", origin: TEST_ORIGIN }) as never,
      },
      frameDocuments: { activate: async () => `/app.html` },
      broker: { registerTab: vi.fn(() => vi.fn()) },
      rpc: createRpcMock(),
      ipcBridge: { waitForReady: vi.fn(async () => undefined) },
      onOpened: vi.fn(),
      onState: vi.fn(),
      onFrameHostMessage,
    });

    await host.applyTheme(":root{--penkra-color-background:#181818}");
    await host.applyTypography(":root{--penkra-font-size-base:12px}");
    const descriptor = await host.openInstalled({
      appId: app.appId,
      spaceId: "personal",
      threadId: "thread-1",
      route: "/",
    });

    expect(onFrameHostMessage).not.toHaveBeenCalled();
    host.markFrameReady(descriptor.id, descriptor.rendererId);
    expect(onFrameHostMessage.mock.calls.map(([message]) => message.delivery)).toEqual([
      {
        kind: "event",
        name: "appearance.theme-css",
        payload: ":root{--penkra-color-background:#181818}",
      },
      {
        kind: "event",
        name: "appearance.typography-css",
        payload: ":root{--penkra-font-size-base:12px}",
      },
    ]);
  });
});
