import { describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  const views: Array<{
    options: unknown;
    bounds: unknown[];
    visible: boolean[];
    webContents: Record<string, unknown>;
  }> = [];
  let nextId = 100;
  class WebContentsView {
    readonly options: unknown;
    readonly bounds: unknown[] = [];
    readonly visible: boolean[] = [];
    readonly webContents: Record<string, unknown>;

    constructor(options: unknown) {
      this.options = options;
      const listeners = new Map<string, (...args: unknown[]) => void>();
      this.webContents = {
        id: nextId++,
        setWindowOpenHandler: vi.fn(),
        on: vi.fn((event: string, listener: (...args: unknown[]) => void) =>
          listeners.set(event, listener),
        ),
        once: vi.fn((event: string, listener: (...args: unknown[]) => void) =>
          listeners.set(event, listener),
        ),
        send: vi.fn(),
        loadURL: vi.fn(async () => undefined),
        insertCSS: vi.fn(async () => "theme-css"),
        removeInsertedCSS: vi.fn(async () => undefined),
        focus: vi.fn(),
        getZoomFactor: vi.fn(() => 1.2),
        setZoomFactor: vi.fn(),
        isDestroyed: vi.fn(() => false),
        close: vi.fn(),
        listeners,
      };
      views.push(this);
    }

    setBounds(bounds: unknown) {
      this.bounds.push(bounds);
    }

    setVisible(visible: boolean) {
      this.visible.push(visible);
    }
  }
  return { WebContentsView, views };
});

vi.mock("electron", () => ({ WebContentsView: electron.WebContentsView }));

import type { InstalledAppPackage } from "./appInstallationState";
import { ElectronAppTabHost, shouldNotifyAppTabClosed } from "./electronAppTabHost";

function installedApp(): InstalledAppPackage {
  const manifest = {
    manifestVersion: 1,
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

describe("ElectronAppTabHost", () => {
  it("preserves persisted shell panes while the host stops or replaces an App", () => {
    expect(shouldNotifyAppTabClosed("host-stopped")).toBe(false);
    expect(shouldNotifyAppTabClosed("app-updated")).toBe(false);
    expect(shouldNotifyAppTabClosed("tab-closed")).toBe(true);
    expect(shouldNotifyAppTabClosed("app-disabled")).toBe(true);
    expect(shouldNotifyAppTabClosed("app-uninstalled")).toBe(true);
  });

  it("owns one isolated view with stable identity through attach, bounds, and close", async () => {
    electron.views.length = 0;
    const app = installedApp();
    const addChildView = vi.fn();
    const removeChildView = vi.fn();
    const focusShell = vi.fn();
    const unregisterBroker = vi.fn();
    const unregisterRpc = vi.fn();
    const releaseIdentity = vi.fn();
    const onRendererCreated = vi.fn(() => releaseIdentity);
    const onOpened = vi.fn();
    const onState = vi.fn();
    const onClosed = vi.fn();
    let markReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const host = new ElectronAppTabHost({
      window: () =>
        ({
          isDestroyed: () => false,
          contentView: { addChildView, removeChildView },
          webContents: { focus: focusShell, getZoomFactor: () => 1.2 },
        }) as never,
      installations: {
        snapshot: () => ({
          packagesByInstallationKey: { [`personal\0${app.appId}`]: app },
        }),
        isActive: () => true,
        setEnabled: vi.fn(),
      } as never,
      sessions: { get: () => ({ appId: app.appId, spaceId: "personal" }) as never },
      broker: { registerTab: vi.fn(() => unregisterBroker) },
      rpc: {
        registerTarget: vi.fn(() => unregisterRpc),
        request: vi.fn(),
      },
      ipcBridge: { waitForReady: vi.fn(() => ready) },
      preloadPath: "/trusted/appPreload.js",
      onOpened,
      onState,
      onClosed,
      onRendererCreated,
      measureRendererMemory: () => 128 * 1024,
    });

    const opening = host.openInstalled({
      appId: app.appId,
      spaceId: "personal",
      threadId: "thread-1",
      route: "/",
    });

    await vi.waitFor(() =>
      expect(onOpened).toHaveBeenCalledWith(
        expect.objectContaining({ appId: app.appId, iconDataUrl: null, status: "loading" }),
      ),
    );
    markReady?.();
    const descriptor = await opening;

    expect(electron.views[0]?.webContents.setZoomFactor).toHaveBeenCalledWith(1.2);
    host.setZoomFactor(0.8);
    expect(electron.views[0]?.webContents.setZoomFactor).toHaveBeenLastCalledWith(0.8);

    expect(descriptor).toMatchObject({
      appId: app.appId,
      spaceId: "personal",
      threadId: "thread-1",
      status: "ready",
    });
    expect(host.list()).toEqual([descriptor]);
    expect(host.has(descriptor.id)).toBe(true);
    expect(host.current()).toBeNull();
    expect(onState).toHaveBeenCalledWith(descriptor);
    expect(onRendererCreated).toHaveBeenCalledWith({
      appId: app.appId,
      spaceId: "personal",
      tabId: descriptor.id,
      threadId: "thread-1",
      rendererId: 100,
    });
    expect(electron.views).toHaveLength(1);
    expect(electron.views[0]?.options).toEqual({
      webPreferences: expect.objectContaining({
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        preload: "/trusted/appPreload.js",
      }),
    });
    expect(host.rendererView(100)).toBe(electron.views[0]);
    expect(host.rendererView(999)).toBeNull();

    host.attach(descriptor.id, descriptor.rendererId);
    host.attach(descriptor.id, descriptor.rendererId);
    expect(addChildView).toHaveBeenCalledOnce();
    host.setBounds(descriptor.id, descriptor.rendererId, {
      x: 1.4,
      y: 2.6,
      width: 300.2,
      height: 400.8,
    });
    expect(electron.views[0]?.bounds.at(-1)).toEqual({ x: 1, y: 3, width: 300, height: 401 });
    host.setVisible(descriptor.id, descriptor.rendererId, true);
    expect(host.current()).toEqual(descriptor);
    expect(electron.views[0]?.webContents.focus).toHaveBeenCalledOnce();
    host.setVisible(descriptor.id, descriptor.rendererId, false);
    expect(host.current()).toBeNull();
    expect(focusShell).toHaveBeenCalledOnce();

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
    expect(removeChildView).toHaveBeenCalledOnce();
    expect(electron.views[0]?.webContents.close).toHaveBeenCalledOnce();
    expect(onClosed).toHaveBeenCalledWith({ id: descriptor.id, threadId: "thread-1" });
    expect(host.list()).toEqual([]);
  });

  it("restores an updated App with the same tab identity", async () => {
    electron.views.length = 0;
    const app = installedApp();
    const attachedViews = new Set<unknown>();
    const host = new ElectronAppTabHost({
      window: () =>
        ({
          isDestroyed: () => false,
          contentView: {
            addChildView: (view: unknown) => attachedViews.add(view),
            removeChildView: (view: unknown) => attachedViews.delete(view),
          },
          webContents: { focus: vi.fn(), getZoomFactor: () => 1 },
        }) as never,
      installations: {
        snapshot: () => ({
          packagesByInstallationKey: { [`personal\0${app.appId}`]: app },
        }),
        isActive: () => true,
        setEnabled: vi.fn(),
      } as never,
      sessions: { get: () => ({ appId: app.appId, spaceId: "personal" }) as never },
      broker: { registerTab: vi.fn(() => vi.fn()) },
      rpc: { registerTarget: vi.fn(() => vi.fn()), request: vi.fn() },
      ipcBridge: { waitForReady: vi.fn(async () => undefined) },
      preloadPath: "/trusted/appPreload.js",
      onOpened: vi.fn(),
      onState: vi.fn(),
      measureRendererMemory: () => 128 * 1024,
    });

    const original = await host.openInstalled({
      appId: app.appId,
      spaceId: "personal",
      threadId: "thread-1",
      route: "/document/7",
      state: { page: 3 },
    });
    const snapshot = host.captureForUpdate(app.appId, "personal");
    host.attach(original.id, original.rendererId);
    host.setVisible(original.id, original.rendererId, true);
    expect(attachedViews).toEqual(new Set([electron.views[0]]));

    host.closeForAppSpace(app.appId, "personal");
    await host.restoreAfterUpdate(app.appId, "personal", snapshot);

    const restored = host.list()[0];
    expect(restored).toBeDefined();
    if (!restored) throw new Error("Updated App tab was not restored.");
    expect(restored.rendererId).not.toBe(original.rendererId);
    expect(host.attach(restored.id, restored.rendererId)).toBe(true);
    expect(host.setVisible(restored.id, restored.rendererId, true)).toBe(true);

    // Cleanup from the retired React effect must not hide or resize the replacement renderer.
    expect(host.setVisible(original.id, original.rendererId, false)).toBe(false);
    expect(
      host.setBounds(original.id, original.rendererId, { x: 0, y: 0, width: 0, height: 0 }),
    ).toBe(false);
    expect(attachedViews).toEqual(new Set([electron.views[1]]));
    expect(electron.views[0]?.webContents.close).toHaveBeenCalledOnce();
    expect(electron.views[1]?.visible.at(-1)).toBe(true);

    expect(host.list()).toEqual([
      expect.objectContaining({
        id: original.id,
        rendererId: restored.rendererId,
        appId: app.appId,
        threadId: "thread-1",
        route: "/document/7",
        status: "ready",
      }),
    ]);
  });

  it("lazily activates a persisted enabled App before opening its UI", async () => {
    electron.views.length = 0;
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
      window: () => null,
      installations: {
        snapshot: () => ({
          packagesByInstallationKey: { [`personal\0${app.appId}`]: app },
        }),
        isActive: () => false,
        ensureActive,
        setEnabled: vi.fn(),
      } as never,
      sessions: { get: () => ({ appId: app.appId, spaceId: "personal" }) as never },
      broker: { registerTab: vi.fn(() => vi.fn()) },
      rpc: { registerTarget: vi.fn(() => vi.fn()), request: vi.fn() },
      ipcBridge: { waitForReady: vi.fn(async () => undefined) },
      preloadPath: "/trusted/appPreload.js",
      onOpened: vi.fn(),
      onState: vi.fn(),
      measureRendererMemory: () => 128 * 1024,
    });

    await expect(
      host.openInstalled({
        appId: app.appId,
        spaceId: "personal",
        threadId: "thread-1",
        route: "/",
      }),
    ).resolves.toMatchObject({ appId: app.appId, status: "ready" });
    expect(ensureActive).toHaveBeenCalledWith(app.appId, "personal");
  });

  it("opens an installed App in the calling Apps tab context", async () => {
    electron.views.length = 0;
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
      window: () => null,
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
      sessions: { get: (appId: string, spaceId: string) => ({ appId, spaceId }) as never },
      broker: { registerTab: vi.fn(() => vi.fn()) },
      rpc: { registerTarget: vi.fn(() => vi.fn()), request: vi.fn() },
      ipcBridge: { waitForReady: vi.fn(async () => undefined) },
      preloadPath: "/trusted/appPreload.js",
      onOpened: vi.fn(),
      onState: vi.fn(),
      onRendererCreated,
      measureRendererMemory: () => 128 * 1024,
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
      status: "ready",
    });
    await expect(host.openInstalledFromRenderer(-1, { appId: target.appId })).rejects.toThrow(
      "originating App tab is unavailable",
    );
  });

  it("keeps Theme and Typography CSS as independent replaceable layers", async () => {
    electron.views.length = 0;
    const app = installedApp();
    const host = new ElectronAppTabHost({
      window: () => null,
      installations: {
        snapshot: () => ({
          packagesByInstallationKey: { [`personal\0${app.appId}`]: app },
        }),
        isActive: () => true,
        setEnabled: vi.fn(),
      } as never,
      sessions: { get: () => ({ appId: app.appId, spaceId: "personal" }) as never },
      broker: { registerTab: vi.fn(() => vi.fn()) },
      rpc: { registerTarget: vi.fn(() => vi.fn()), request: vi.fn() },
      ipcBridge: { waitForReady: vi.fn(async () => undefined) },
      preloadPath: "/trusted/appPreload.js",
      onOpened: vi.fn(),
      onState: vi.fn(),
      measureRendererMemory: () => 128 * 1024,
    });

    await host.applyTheme(":root{--penkra-color-background:#181818}");
    await host.applyTypography(":root{--penkra-font-size-base:12px}");
    await host.openInstalled({
      appId: app.appId,
      spaceId: "personal",
      threadId: "thread-1",
      route: "/",
    });

    const contents = electron.views[0]?.webContents;
    expect(contents?.insertCSS).toHaveBeenNthCalledWith(
      1,
      ":root{--penkra-color-background:#181818}",
      { cssOrigin: "author" },
    );
    expect(contents?.insertCSS).toHaveBeenNthCalledWith(2, ":root{--penkra-font-size-base:12px}", {
      cssOrigin: "author",
    });
  });
});
