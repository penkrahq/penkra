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
        on: vi.fn((event: string, listener: (...args: unknown[]) => void) => listeners.set(event, listener)),
        once: vi.fn((event: string, listener: (...args: unknown[]) => void) => listeners.set(event, listener)),
        send: vi.fn(),
        loadURL: vi.fn(async () => undefined),
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
import { ElectronAppTabHost } from "./electronAppTabHost";

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
  it("owns one isolated view with stable identity through attach, bounds, and close", async () => {
    electron.views.length = 0;
    const app = installedApp();
    const addChildView = vi.fn();
    const removeChildView = vi.fn();
    const unregisterBroker = vi.fn();
    const unregisterRpc = vi.fn();
    const releaseIdentity = vi.fn();
    const onRendererCreated = vi.fn(() => releaseIdentity);
    const onOpened = vi.fn();
    const host = new ElectronAppTabHost({
      window: () => ({
        isDestroyed: () => false,
        contentView: { addChildView, removeChildView },
      }) as never,
      installations: {
        snapshot: () => ({ packagesByAppId: { [app.appId]: app } }),
        isActive: () => true,
        setEnabled: vi.fn(),
      } as never,
      sessions: { get: () => ({ appId: app.appId, spaceId: "personal" }) as never },
      broker: { registerTab: vi.fn(() => unregisterBroker) },
      rpc: {
        registerTarget: vi.fn(() => unregisterRpc),
        request: vi.fn(),
      },
      ipcBridge: { waitForReady: vi.fn(async () => undefined) },
      preloadPath: "/trusted/appPreload.js",
      onOpened,
      onState: vi.fn(),
      onRendererCreated,
    });

    const descriptor = await host.openInstalled({
      appId: app.appId,
      spaceId: "personal",
      threadId: "thread-1",
      route: "/",
    });

    expect(descriptor).toMatchObject({
      appId: app.appId,
      spaceId: "personal",
      threadId: "thread-1",
      status: "ready",
    });
    expect(host.list()).toEqual([descriptor]);
    expect(onOpened).toHaveBeenCalledWith(descriptor);
    expect(onRendererCreated).toHaveBeenCalledWith({
      appId: app.appId,
      spaceId: "personal",
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

    host.attach(descriptor.id);
    host.attach(descriptor.id);
    expect(addChildView).toHaveBeenCalledOnce();
    host.setBounds(descriptor.id, { x: 1.4, y: 2.6, width: 300.2, height: 400.8 });
    expect(electron.views[0]?.bounds.at(-1)).toEqual({ x: 1, y: 3, width: 300, height: 401 });

    host.close(descriptor.id);
    host.close(descriptor.id);
    expect(unregisterBroker).toHaveBeenCalledOnce();
    expect(unregisterRpc).toHaveBeenCalledWith("tab-closed");
    expect(releaseIdentity).toHaveBeenCalledOnce();
    expect(removeChildView).toHaveBeenCalledOnce();
    expect(electron.views[0]?.webContents.close).toHaveBeenCalledOnce();
    expect(host.list()).toEqual([]);
  });
});
