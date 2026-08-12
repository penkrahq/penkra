import { describe, expect, it, vi } from "vitest";

import type { WebContentsView } from "electron";

import type { InstalledAppPackage } from "./appInstallationState";
import { ElectronAppControllerRendererFactory } from "./electronAppControllerRenderer";
import { APP_RUNTIME_IPC_CHANNELS } from "./ipcChannels";
import { createAppSessionPartition } from "./appRuntimePolicy";
import type { ActiveAppSession } from "./appSessionManager";

function installedApp(): InstalledAppPackage {
  const manifest = {
    manifestVersion: 1,
    id: "com.acme.linear",
    slug: "linear",
    name: "Linear",
    summary: "Manage Linear issues.",
    version: "1.0.0",
    compatibility: { penkra: ">=0.8.0" },
    icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml" }],
    entrypoints: { app: "app.html", operations: "operations.html" },
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

function fixture() {
  const listeners = new Map<string, Set<(...args: never[]) => void>>();
  const contents = {
    id: 77,
    setAudioMuted: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    on: vi.fn((event: string, listener: (...args: never[]) => void) => {
      const values = listeners.get(event) ?? new Set();
      values.add(listener);
      listeners.set(event, values);
    }),
    once: vi.fn((event: string, listener: (...args: never[]) => void) => {
      const values = listeners.get(event) ?? new Set();
      values.add(listener);
      listeners.set(event, values);
    }),
    removeListener: vi.fn((event: string, listener: (...args: never[]) => void) => {
      listeners.get(event)?.delete(listener);
    }),
    send: vi.fn(),
    loadURL: vi.fn(async () => undefined),
    isDestroyed: vi.fn(() => false),
    close: vi.fn(),
  };
  const waitForReady = vi.fn<(rendererId: number, signal?: AbortSignal) => Promise<void>>(
    async () => undefined,
  );
  const createView = vi.fn(() => ({ webContents: contents }) as unknown as WebContentsView);
  const factory = new ElectronAppControllerRendererFactory({
    preloadPath: "/trusted/appPreload.js",
    ipcBridge: { waitForReady },
    createView,
  });
  const app = installedApp();
  const session: ActiveAppSession = {
    appId: app.appId,
    spaceId: "personal",
    partition: createAppSessionPartition(app.appId, "personal"),
    session: {} as ActiveAppSession["session"],
  };
  return {
    factory,
    contents,
    listeners,
    waitForReady,
    createView,
    app,
    session,
  };
}

describe("ElectronAppControllerRendererFactory", () => {
  it("creates an unattached hardened controller in the activated App session", async () => {
    const test = fixture();
    const renderer = test.factory.create({
      installedApp: test.app,
      spaceId: "personal",
      session: test.session,
    });
    expect(test.createView).toHaveBeenCalledWith({
      webPreferences: expect.objectContaining({
        partition: test.session.partition,
        preload: "/trusted/appPreload.js",
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
      }),
    });
    expect(test.contents.setAudioMuted).toHaveBeenCalledWith(true);
    expect(test.contents.setWindowOpenHandler).toHaveBeenCalledOnce();

    await renderer.start("penkra-app://com.acme.linear/operations.html");
    expect(test.waitForReady).toHaveBeenCalledWith(77, expect.any(AbortSignal));
    expect(test.contents.loadURL).toHaveBeenCalledWith(
      "penkra-app://com.acme.linear/operations.html",
    );
  });

  it("denies popup creation and renderer-initiated navigation outside the App origin", () => {
    const test = fixture();
    test.factory.create({
      installedApp: test.app,
      spaceId: "personal",
      session: test.session,
    });
    const openHandler = test.contents.setWindowOpenHandler.mock.calls[0]?.[0];
    expect(openHandler({ url: "https://example.com" })).toEqual({
      action: "deny",
    });

    const navigate = [...(test.listeners.get("will-navigate") ?? [])][0];
    const external = { url: "https://example.com", preventDefault: vi.fn() };
    navigate?.(external as never);
    expect(external.preventDefault).toHaveBeenCalledOnce();
    const internal = {
      url: "penkra-app://com.acme.linear/issues",
      preventDefault: vi.fn(),
    };
    navigate?.(internal as never);
    expect(internal.preventDefault).not.toHaveBeenCalled();
  });

  it("sends only through the App runtime host channel and closes idempotently", () => {
    const test = fixture();
    const renderer = test.factory.create({
      installedApp: test.app,
      spaceId: "personal",
      session: test.session,
    });
    renderer.send({ type: "cancel", id: "request-1", reason: "app-disabled" });
    expect(test.contents.send).toHaveBeenCalledWith(
      APP_RUNTIME_IPC_CHANNELS.hostMessage,
      expect.any(Object),
    );
    renderer.destroy();
    expect(test.contents.close).toHaveBeenCalledOnce();
  });

  it("rejects a mismatched session partition before creating a renderer", () => {
    const test = fixture();
    expect(() =>
      test.factory.create({
        installedApp: test.app,
        spaceId: "work",
        session: test.session,
      }),
    ).toThrow("session partition does not match");
    expect(test.createView).not.toHaveBeenCalled();
  });

  it("reports a preload failure immediately instead of timing out waiting for readiness", async () => {
    const test = fixture();
    test.waitForReady.mockImplementation(
      (_rendererId, signal) =>
        new Promise<void>((_resolve, reject) => {
          if (!signal) throw new Error("Expected a readiness abort signal.");
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const renderer = test.factory.create({
      installedApp: test.app,
      spaceId: "personal",
      session: test.session,
    });

    const started = renderer.start("penkra-app://com.acme.linear/operations.html");
    const preloadError = [...(test.listeners.get("preload-error") ?? [])][0];
    preloadError?.(
      {} as never,
      "/trusted/appPreload.js" as never,
      new Error("Cannot find module './ipcChannels.js'") as never,
    );

    await expect(started).rejects.toThrow(
      "App controller preload failed (/trusted/appPreload.js): Cannot find module './ipcChannels.js'",
    );
    expect(test.listeners.get("preload-error")?.size).toBe(0);
  });
});
