import { describe, expect, it, vi } from "vitest";

const TEST_ORIGIN = `penkra-app://a-${"a".repeat(64)}`;

import type { InstalledAppPackage } from "./appInstallationState";
import { ElectronAppTabHost, shouldNotifyAppTabClosed } from "./electronAppTabHost";

function installedApp(): InstalledAppPackage {
  const manifest = {
    manifestVersion: 2,
    id: "com.penkra.apps",
    slug: "apps",
    name: "Apps",
    summary: "Discover and manage Apps.",
    version: "0.1.0",
    compatibility: { penkra: ">=0.8.0" },
    icons: [{ src: "assets/icon.svg", sizes: "any", type: "image/svg+xml" }],
    entrypoints: { app: "app.html", operations: "operations.html" },
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
    const onRendererCreated = vi.fn(() => releaseIdentity);
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
      onRendererCreated,
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
      documentUrl: expect.stringMatching(/^\/app\.html#penkra-tab=/),
    });
    expect(host.list()).toEqual([descriptor]);
    expect(host.has(descriptor.id)).toBe(true);
    expect(host.current()).toBeNull();
    onOpened.mockClear();
    host.present(descriptor.id);
    expect(onOpened).toHaveBeenCalledWith(descriptor);
    expect(onState).not.toHaveBeenCalled();
    expect(onRendererCreated).toHaveBeenCalledWith({
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

    host.closeForAppSpace(app.appId, "personal");
    await host.restoreAfterUpdate(app.appId, "personal", snapshot);

    const restored = host.list()[0];
    expect(restored).toBeDefined();
    if (!restored) throw new Error("Updated App tab was not restored.");
    expect(restored.rendererId).not.toBe(original.rendererId);
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
    const onRendererCreated = vi.fn(
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
      onRendererCreated,
    });

    await host.openInstalled({
      appId: apps.appId,
      spaceId: "personal",
      threadId: "thread-1",
      route: "/",
    });
    const renderer = onRendererCreated.mock.calls[0]?.[0];
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
