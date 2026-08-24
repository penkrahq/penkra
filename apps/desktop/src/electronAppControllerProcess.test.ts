import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import type { InstalledAppPackage } from "./appInstallationState";
import {
  ElectronAppControllerProcessFactory,
  appControllerEnvironment,
} from "./electronAppControllerProcess";
import type { ActiveAppSession } from "./appSessionManager";

function installedApp(): InstalledAppPackage {
  const manifest = {
    manifestVersion: 2,
    id: "com.acme.linear",
    slug: "linear",
    name: "Linear",
    summary: "Manage Linear issues.",
    version: "1.0.0",
    compatibility: { penkra: ">=0.8.0" },
    icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml" }],
    entrypoints: { app: "app.html", operations: "operations.js" },
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
  const child = new EventEmitter() as EventEmitter & {
    pid: number | undefined;
    connected: boolean;
    send: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = 123;
  child.connected = true;
  child.send = vi.fn();
  child.kill = vi.fn(() => true);
  const fork = vi.fn(() => child as never);
  const rpc = { acceptResponse: vi.fn(), acceptContextCall: vi.fn() };
  const serviceCall = vi.fn(async () => ({ ok: true }));
  const factory = new ElectronAppControllerProcessFactory({
    runnerPath: "/trusted/appNodeControllerRunner.js",
    rpc,
    serviceCall,
    fork,
  });
  const app = installedApp();
  const session = {
    appId: app.appId,
    spaceId: "personal",
    partition: "persist:test",
    origin: `penkra-app://a-${"a".repeat(64)}`,
    session: {} as ActiveAppSession["session"],
  };
  return { child, fork, rpc, serviceCall, factory, app, session };
}

describe("ElectronAppControllerProcessFactory", () => {
  it("inherits ordinary OS context without leaking host or provider credentials", () => {
    expect(
      appControllerEnvironment({
        HOME: "/Users/test",
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
        PATH: "/usr/bin:/bin",
        PENKRA_AUTH_TOKEN: "host-secret",
        OPENAI_API_KEY: "provider-secret",
        NODE_OPTIONS: "--inspect",
      }),
    ).toEqual({
      ELECTRON_RUN_AS_NODE: "1",
      HOME: "/Users/test",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      PATH: "/usr/bin:/bin",
    });
  });

  it("starts a dedicated permission-bounded Node process and waits for controller readiness", async () => {
    const test = fixture();
    const controller = test.factory.create({
      installedApp: test.app,
      spaceId: "personal",
      session: test.session,
    });
    const started = controller.start("/profile/apps/com.acme.linear/1.0.0/operations.js");
    test.child.emit("message", { type: "ready" });
    await expect(started).resolves.toBeUndefined();
    expect(test.fork).toHaveBeenCalledWith(
      "/trusted/appNodeControllerRunner.js",
      ["/profile/apps/com.acme.linear/1.0.0/operations.js", "com.acme.linear"],
      expect.objectContaining({
        cwd: "/profile/apps/com.acme.linear/1.0.0",
        execArgv: ["--permission", "--allow-fs-read=*", "--allow-fs-write=*", "--no-addons"],
        execPath: process.execPath,
        env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: "1" }),
        serialization: "advanced",
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      }),
    );
  });

  it("routes operation RPC and host SDK service calls over the process port", async () => {
    const test = fixture();
    const controller = test.factory.create({
      installedApp: test.app,
      spaceId: "personal",
      session: test.session,
    });
    const started = controller.start("/profile/apps/com.acme.linear/1.0.0/operations.js");
    test.child.emit("message", { type: "ready" });
    await started;
    test.child.emit("message", { type: "result", id: "request-1", result: 1 });
    test.child.emit("message", {
      type: "context-call",
      parentId: "request-1",
      id: "context-1",
      method: "context.tabs.open",
      input: { route: "/" },
    });
    test.child.emit("message", {
      type: "service-call",
      id: "service-1",
      method: "settings.get",
      input: "theme",
    });
    await vi.waitFor(() => expect(test.serviceCall).toHaveBeenCalledOnce());
    expect(test.rpc.acceptResponse).toHaveBeenCalledWith(controller.id, expect.any(Object));
    expect(test.rpc.acceptContextCall).toHaveBeenCalledWith(controller.id, expect.any(Object));
    expect(test.child.send).toHaveBeenCalledWith({
      type: "service-result",
      id: "service-1",
      result: { ok: true },
    });
  });

  it("kills the process without reporting an expected release as a crash", async () => {
    const test = fixture();
    const controller = test.factory.create({
      installedApp: test.app,
      spaceId: "personal",
      session: test.session,
    });
    const destroyed = vi.fn();
    controller.onDestroyed(destroyed);
    const started = controller.start("/profile/apps/com.acme.linear/1.0.0/operations.js");
    test.child.emit("message", { type: "ready" });
    await started;
    controller.destroy();
    test.child.emit("exit", 0);
    expect(test.child.kill).toHaveBeenCalledOnce();
    expect(destroyed).not.toHaveBeenCalled();
  });

  it("rejects startup errors and reports runtime process errors once", async () => {
    const startup = fixture();
    const starting = startup.factory
      .create({ installedApp: startup.app, spaceId: "personal", session: startup.session })
      .start("/profile/apps/com.acme.linear/1.0.0/operations.js");
    startup.child.emit("error", new Error("spawn failed"));
    await expect(starting).rejects.toThrow("spawn failed");

    const runtime = fixture();
    const controller = runtime.factory.create({
      installedApp: runtime.app,
      spaceId: "personal",
      session: runtime.session,
    });
    const started = controller.start("/profile/apps/com.acme.linear/1.0.0/operations.js");
    runtime.child.emit("message", { type: "ready" });
    await started;
    runtime.child.emit("error", new Error("runtime failed"));
    const destroyed = vi.fn();
    controller.onDestroyed(destroyed);
    await vi.waitFor(() => expect(destroyed).toHaveBeenCalledOnce());
    runtime.child.emit("exit", 1);
    expect(destroyed).toHaveBeenCalledOnce();
  });
});
