import { beforeEach, describe, expect, it, vi } from "vitest";

import type { InstalledAppPackage } from "./appInstallationState";

const electron = vi.hoisted(() => ({
  fromPartition: vi.fn(),
}));

vi.mock("electron", () => ({
  session: { fromPartition: electron.fromPartition },
}));

import { AppSessionManager } from "./appSessionManager";
import { createAppSessionPartition, PENKRA_APP_SCHEME } from "./appRuntimePolicy";

function installedApp(patch: Partial<InstalledAppPackage> = {}): InstalledAppPackage {
  const manifest = {
    manifestVersion: 1,
    id: "com.penkra.apps",
    slug: "apps",
    name: "Apps",
    summary: "Discover and manage Penkra Apps.",
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
    packagePath: "/profile/apps/com.penkra.apps/1.0.0",
    sha256: "a".repeat(64),
    installedAt: "2026-08-01T00:00:00.000Z",
    manifest,
    ...patch,
  };
}

function sessionFixture() {
  const listeners = {
    download: null as null | ((event: { preventDefault(): void }) => void),
    request: null as
      | null
      | ((details: { url: string }, callback: (value: unknown) => void) => void),
    protocol: null as null | ((request: Request) => Promise<Response>),
  };
  const fixture = {
    listeners,
    session: {
      clearAuthCache: vi.fn(async () => undefined),
      clearData: vi.fn(async () => undefined),
      on: vi.fn((event, listener) => {
        if (event === "will-download") listeners.download = listener;
      }),
      protocol: {
        handle: vi.fn(async (_scheme, handler) => {
          listeners.protocol = handler;
        }),
        unhandle: vi.fn(async () => undefined),
      },
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      webRequest: {
        onBeforeRequest: vi.fn((_filter, listener) => {
          listeners.request = listener;
        }),
      },
    },
  };
  return fixture;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AppSessionManager", () => {
  it("creates and hardens one persistent session per App and Space", async () => {
    const fixture = sessionFixture();
    electron.fromPartition.mockReturnValue(fixture.session);
    const protocolHandler = vi.fn(async () => new Response("v1"));
    const manager = new AppSessionManager({
      createProtocolHandler: vi.fn(async () => protocolHandler),
    });

    const active = await manager.activate({ installedApp: installedApp(), spaceId: "personal" });

    expect(electron.fromPartition).toHaveBeenCalledWith(
      createAppSessionPartition("com.penkra.apps", "personal"),
      { cache: true },
    );
    expect(active.session).toBe(fixture.session);
    expect(fixture.session.setPermissionCheckHandler).toHaveBeenCalledOnce();
    expect(fixture.session.setPermissionRequestHandler).toHaveBeenCalledOnce();
    const preventDownload = vi.fn();
    fixture.listeners.download?.({ preventDefault: preventDownload });
    expect(preventDownload).toHaveBeenCalledOnce();
    expect(fixture.session.protocol.handle).toHaveBeenCalledWith(
      PENKRA_APP_SCHEME,
      expect.any(Function),
    );

    const checkPermission = fixture.session.setPermissionCheckHandler.mock.calls[0]?.[0];
    expect(checkPermission()).toBe(false);
    const requestPermission = fixture.session.setPermissionRequestHandler.mock.calls[0]?.[0];
    const permissionCallback = vi.fn();
    requestPermission({}, "notifications", permissionCallback);
    await vi.waitFor(() => expect(permissionCallback).toHaveBeenCalledWith(false));
  });

  it("blocks direct remote requests while allowing only the assigned App origin", async () => {
    const fixture = sessionFixture();
    electron.fromPartition.mockReturnValue(fixture.session);
    const manager = new AppSessionManager({
      createProtocolHandler: vi.fn(async () => async () => new Response("ok")),
    });
    await manager.activate({ installedApp: installedApp(), spaceId: "personal" });
    const listener = fixture.listeners.request;
    expect(listener).not.toBeNull();
    if (!listener) return;

    const localCallback = vi.fn();
    listener({ url: "penkra-app://com.penkra.apps/app.html" }, localCallback);
    expect(localCallback).toHaveBeenCalledWith({ cancel: false });
    const remoteCallback = vi.fn();
    listener({ url: "https://api.example.com/issues" }, remoteCallback);
    expect(remoteCallback).toHaveBeenCalledWith({ cancel: true });
  });

  it("atomically switches verified package handlers without reconfiguring the session", async () => {
    const fixture = sessionFixture();
    electron.fromPartition.mockReturnValue(fixture.session);
    const v1 = vi.fn(async () => new Response("v1"));
    const v2 = vi.fn(async () => new Response("v2"));
    const createProtocolHandler = vi.fn().mockResolvedValueOnce(v1).mockResolvedValueOnce(v2);
    const manager = new AppSessionManager({ createProtocolHandler });
    await manager.activate({ installedApp: installedApp(), spaceId: "personal" });
    const protocolDelegate = fixture.listeners.protocol;
    expect(protocolDelegate).not.toBeNull();
    if (!protocolDelegate) return;
    await expect(
      (await protocolDelegate(new Request("penkra-app://com.penkra.apps/app.html"))).text(),
    ).resolves.toBe("v1");

    await manager.activate({
      installedApp: installedApp({
        version: "2.0.0",
        packagePath: "/profile/apps/com.penkra.apps/2.0.0",
        manifest: { ...installedApp().manifest, version: "2.0.0" },
      }),
      spaceId: "personal",
    });
    await expect(
      (await protocolDelegate(new Request("penkra-app://com.penkra.apps/app.html"))).text(),
    ).resolves.toBe("v2");
    expect(electron.fromPartition).toHaveBeenCalledOnce();
    expect(fixture.session.protocol.handle).toHaveBeenCalledOnce();
  });

  it("keeps the working handler when replacement preparation fails", async () => {
    const fixture = sessionFixture();
    electron.fromPartition.mockReturnValue(fixture.session);
    const v1 = vi.fn(async () => new Response("v1"));
    const createProtocolHandler = vi
      .fn()
      .mockResolvedValueOnce(v1)
      .mockRejectedValueOnce(new Error("invalid updated package"));
    const manager = new AppSessionManager({ createProtocolHandler });
    await manager.activate({ installedApp: installedApp(), spaceId: "personal" });

    await expect(
      manager.activate({
        installedApp: installedApp({ packagePath: "/invalid/update" }),
        spaceId: "personal",
      }),
    ).rejects.toThrow("invalid updated package");
    const protocolDelegate = fixture.listeners.protocol;
    expect(protocolDelegate).not.toBeNull();
    if (!protocolDelegate) return;
    await expect(
      (await protocolDelegate(new Request("penkra-app://com.penkra.apps/app.html"))).text(),
    ).resolves.toBe("v1");
  });

  it("serializes activation and deactivation for one partition", async () => {
    const fixture = sessionFixture();
    electron.fromPartition.mockReturnValue(fixture.session);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = new AppSessionManager({
      createProtocolHandler: vi.fn(async () => {
        await gate;
        return async () => new Response("ok");
      }),
    });
    const activation = manager.activate({ installedApp: installedApp(), spaceId: "personal" });
    const deactivation = manager.deactivate("com.penkra.apps", "personal");
    expect(fixture.session.protocol.unhandle).not.toHaveBeenCalled();

    release?.();
    await activation;
    await expect(deactivation).resolves.toBe(true);
    expect(fixture.session.protocol.unhandle).toHaveBeenCalledWith(PENKRA_APP_SCHEME);
    expect(manager.get("com.penkra.apps", "personal")).toBeNull();
  });

  it("isolates the same App across Spaces", async () => {
    const personal = sessionFixture();
    const work = sessionFixture();
    electron.fromPartition.mockReturnValueOnce(personal.session).mockReturnValueOnce(work.session);
    const manager = new AppSessionManager({
      createProtocolHandler: vi.fn(async () => async () => new Response("ok")),
    });

    const [personalSession, workSession] = await Promise.all([
      manager.activate({ installedApp: installedApp(), spaceId: "personal" }),
      manager.activate({ installedApp: installedApp(), spaceId: "work" }),
    ]);
    expect(personalSession.partition).not.toBe(workSession.partition);
    expect(personalSession.session).not.toBe(workSession.session);
  });

  it("erases the complete inactive persistent partition", async () => {
    const fixture = sessionFixture();
    electron.fromPartition.mockReturnValue(fixture.session);
    const manager = new AppSessionManager();

    await manager.eraseData("com.penkra.apps", "personal");

    expect(electron.fromPartition).toHaveBeenCalledWith(
      createAppSessionPartition("com.penkra.apps", "personal"),
      { cache: true },
    );
    expect(fixture.session.clearData).toHaveBeenCalledOnce();
    expect(fixture.session.clearAuthCache).toHaveBeenCalledOnce();
  });

  it("refuses to erase a live App partition", async () => {
    const fixture = sessionFixture();
    electron.fromPartition.mockReturnValue(fixture.session);
    const manager = new AppSessionManager({
      createProtocolHandler: vi.fn(async () => async () => new Response("ok")),
    });
    await manager.activate({ installedApp: installedApp(), spaceId: "personal" });

    await expect(manager.eraseData("com.penkra.apps", "personal")).rejects.toThrow(
      "must be inactive",
    );
    expect(fixture.session.clearData).not.toHaveBeenCalled();
  });
});
