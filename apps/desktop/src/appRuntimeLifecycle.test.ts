import { describe, expect, it, vi } from "vitest";

import {
  createEmptyAppInstallationState,
  registerVerifiedAppPackage,
  setSpaceAppEnabled,
  type AppInstallationState,
  type InstalledAppPackage,
} from "./appInstallationState";
import { AppRuntimeLifecycle } from "./appRuntimeLifecycle";
import type { OperationCancellationCode } from "@penkra/sdk";
import type { ActivateAppSessionInput, ActiveAppSession } from "./appSessionManager";

function installedState(enabled = false): AppInstallationState {
  const installed = registerVerifiedAppPackage(
    createEmptyAppInstallationState(),
    {
      manifest: {
        manifestVersion: 1,
        id: "com.penkra.apps",
        slug: "apps",
        name: "Apps",
        summary: "Discover and manage Penkra Apps.",
        version: "1.0.0",
        compatibility: { penkra: ">=0.8.0" },
        icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml" }],
        entrypoints: { app: "app.html", operations: "operations.html" },
      },
      source: "registry",
      packagePath: "/profile/apps/com.penkra.apps/1.0.0",
      sha256: "a".repeat(64),
      installedAt: "2026-08-01T00:00:00.000Z",
    },
    "personal",
  );
  return setSpaceAppEnabled(installed, {
    appId: "com.penkra.apps",
    spaceId: "personal",
    enabled,
  });
}

function fixture(
  initial = installedState(),
  assertAppAllowed?: (app: InstalledAppPackage) => Promise<void>,
) {
  let state = initial;
  const store = {
    snapshot: vi.fn(() => state),
    mutate: vi.fn(async (transition: (value: AppInstallationState) => AppInstallationState) => {
      state = transition(state);
      return state;
    }),
  };
  const releaseController = vi.fn(async (_reason?: OperationCancellationCode) => undefined);
  const sessions = {
    activate: vi.fn(async (input: ActivateAppSessionInput) => activeSession(input)),
    deactivate: vi.fn(async () => true),
  };
  const controllers = {
    activate: vi.fn(
      async (_input: { onUnexpectedExit?: (error: Error) => void }) => releaseController,
    ),
  };
  const closeTabs = vi.fn();
  return {
    lifecycle: new AppRuntimeLifecycle({
      store,
      sessions,
      controllers,
      ...(assertAppAllowed === undefined ? {} : { assertAppAllowed }),
      closeTabs,
    }),
    store,
    sessions,
    controllers,
    releaseController,
    closeTabs,
    state: () => state,
  };
}

describe("AppRuntimeLifecycle", () => {
  it("rejects blocked Apps before creating a session or controller", async () => {
    const assertAppAllowed = vi.fn().mockRejectedValue(new Error("App release revoked"));
    const test = fixture(installedState(), assertAppAllowed);

    await expect(test.lifecycle.enable("com.penkra.apps", "personal")).rejects.toThrow("revoked");
    expect(assertAppAllowed).toHaveBeenCalledOnce();
    expect(test.sessions.activate).not.toHaveBeenCalled();
    expect(test.controllers.activate).not.toHaveBeenCalled();
    expect(test.store.mutate).not.toHaveBeenCalled();
  });

  it("activates session and controller before publishing enabled state", async () => {
    const test = fixture();
    const events: string[] = [];
    test.sessions.activate.mockImplementation(async (input) => {
      events.push("session");
      return activeSession(input);
    });
    test.controllers.activate.mockImplementation(async () => {
      events.push("controller");
      return test.releaseController;
    });
    test.store.mutate.mockImplementation(async (transition) => {
      events.push("persist");
      const next = transition(test.state());
      return next;
    });

    const state = await test.lifecycle.enable("com.penkra.apps", "personal");
    expect(events).toEqual(["session", "controller", "persist"]);
    expect(Object.values(state.spaceStateByKey)[0]?.enabled).toBe(true);
    expect(test.lifecycle.isActive("com.penkra.apps", "personal")).toBe(true);
  });

  it("rolls back newly activated runtime when persistence fails", async () => {
    const test = fixture();
    test.store.mutate.mockRejectedValueOnce(new Error("disk full"));

    await expect(test.lifecycle.enable("com.penkra.apps", "personal")).rejects.toThrow("disk full");
    expect(test.releaseController).toHaveBeenCalledOnce();
    expect(test.sessions.deactivate).toHaveBeenCalledWith("com.penkra.apps", "personal");
    expect(test.lifecycle.isActive("com.penkra.apps", "personal")).toBe(false);
  });

  it("publishes disabled state before tearing down the runtime", async () => {
    const test = fixture();
    await test.lifecycle.enable("com.penkra.apps", "personal");
    const events: string[] = [];
    test.store.mutate.mockImplementation(async (transition) => {
      events.push("persist-disabled");
      return transition(test.state());
    });
    test.releaseController.mockImplementation(async () => {
      events.push("controller-stop");
    });
    test.sessions.deactivate.mockImplementation(async () => {
      events.push("session-stop");
      return true;
    });

    const state = await test.lifecycle.disable("com.penkra.apps", "personal");
    expect(events).toEqual(["persist-disabled", "controller-stop", "session-stop"]);
    expect(test.closeTabs).toHaveBeenCalledWith("com.penkra.apps", "personal", "app-disabled");
    expect(Object.values(state.spaceStateByKey)[0]?.enabled).toBe(false);
  });

  it("still closes the session when controller teardown fails", async () => {
    const test = fixture();
    await test.lifecycle.enable("com.penkra.apps", "personal");
    test.releaseController.mockRejectedValueOnce(new Error("controller stop failed"));

    await expect(test.lifecycle.disable("com.penkra.apps", "personal")).rejects.toThrow(
      "controller stop failed",
    );
    expect(test.sessions.deactivate).toHaveBeenCalledWith("com.penkra.apps", "personal");
    expect(Object.values(test.state().spaceStateByKey)[0]?.enabled).toBe(false);
  });

  it("restores enabled runtimes independently and reports failures without rewriting intent", async () => {
    let state = installedState(true);
    const secondManifest = {
      ...state.packagesByInstallationKey["personal\0com.penkra.apps"]!.manifest,
      id: "com.acme.linear",
      slug: "linear",
      name: "Linear",
    };
    state = registerVerifiedAppPackage(
      state,
      {
        manifest: secondManifest,
        source: "registry",
        packagePath: "/profile/apps/com.acme.linear/1.0.0",
        sha256: "b".repeat(64),
        installedAt: "2026-08-01T00:00:00.000Z",
      },
      "personal",
    );
    state = setSpaceAppEnabled(state, {
      appId: "com.acme.linear",
      spaceId: "personal",
      enabled: true,
    });
    const test = fixture(state);
    test.sessions.activate.mockImplementation(async (input) => {
      if (input.installedApp.appId === "com.acme.linear") {
        throw new Error("package unavailable");
      }
      return activeSession(input);
    });

    const result = await test.lifecycle.restoreEnabled();
    expect(result).toEqual(
      expect.arrayContaining([
        { status: "active", appId: "com.penkra.apps", spaceId: "personal" },
        expect.objectContaining({
          status: "failed",
          appId: "com.acme.linear",
          spaceId: "personal",
        }),
      ]),
    );
    expect(Object.values(test.state().spaceStateByKey).every((item) => item.enabled)).toBe(true);
  });

  it("serializes enable and disable for the same App and Space", async () => {
    const test = fixture();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    test.sessions.activate.mockImplementation(async (input) => {
      await gate;
      return activeSession(input);
    });

    const enabled = test.lifecycle.enable("com.penkra.apps", "personal");
    const disabled = test.lifecycle.disable("com.penkra.apps", "personal");
    expect(test.store.mutate).not.toHaveBeenCalled();
    release?.();
    await enabled;
    await disabled;
    expect(Object.values(test.state().spaceStateByKey)[0]?.enabled).toBe(false);
  });

  it("stops active runtimes on shutdown without rewriting persisted enablement", async () => {
    const test = fixture();
    await test.lifecycle.enable("com.penkra.apps", "personal");

    await test.lifecycle.shutdown();

    expect(test.releaseController).toHaveBeenCalledWith("host-stopped");
    expect(test.sessions.deactivate).toHaveBeenCalledWith("com.penkra.apps", "personal");
    expect(Object.values(test.state().spaceStateByKey)[0]?.enabled).toBe(true);
    expect(test.lifecycle.isActive("com.penkra.apps", "personal")).toBe(false);
  });

  it("persists a deterministic safe disable when an operation controller exits", async () => {
    const test = fixture();
    const unexpected = vi.fn();
    test.lifecycle.subscribeUnexpectedDisable(unexpected);
    await test.lifecycle.enable("com.penkra.apps", "personal");
    const activation = test.controllers.activate.mock.calls[0]?.[0];

    activation?.onUnexpectedExit?.(new Error("controller crashed"));

    await vi.waitFor(() =>
      expect(test.lifecycle.isActive("com.penkra.apps", "personal")).toBe(false),
    );
    expect(Object.values(test.state().spaceStateByKey)[0]?.enabled).toBe(false);
    expect(test.closeTabs).toHaveBeenCalledWith("com.penkra.apps", "personal", "app-disabled");
    expect(test.sessions.deactivate).toHaveBeenCalledWith("com.penkra.apps", "personal");
    expect(unexpected).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: "com.penkra.apps",
        spaceId: "personal",
        error: expect.objectContaining({ message: "controller crashed" }),
        state: expect.any(Object),
      }),
    );
  });

  it("fails activation if the controller exits before activation commits", async () => {
    const test = fixture();
    test.controllers.activate.mockImplementationOnce(async (input) => {
      input.onUnexpectedExit?.(new Error("controller exited during start"));
      return test.releaseController;
    });

    await expect(test.lifecycle.enable("com.penkra.apps", "personal")).rejects.toThrow(
      "controller exited during start",
    );

    expect(test.releaseController).toHaveBeenCalledOnce();
    expect(test.sessions.deactivate).toHaveBeenCalledWith("com.penkra.apps", "personal");
    expect(test.store.mutate).not.toHaveBeenCalled();
  });
});

function activeSession(input: ActivateAppSessionInput): ActiveAppSession {
  return {
    appId: input.installedApp.appId,
    spaceId: input.spaceId,
    partition: "persist:test",
    session: {} as ActiveAppSession["session"],
  };
}
