import { describe, expect, it, vi } from "vitest";

import {
  createEmptyAppInstallationState,
  type AppInstallationState,
  type VerifiedAppPackageInput,
} from "./appInstallationState";
import { AppInstallationService } from "./appInstallationService";

function verifiedPackage(): VerifiedAppPackageInput {
  return {
    manifest: {
      manifestVersion: 1,
      id: "com.acme.figma",
      slug: "figma",
      name: "Figma",
      summary: "Review Figma designs.",
      version: "1.0.0",
      compatibility: { penkra: ">=0.8.0" },
      icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml" }],
      entrypoints: { app: "app.html" },
      permissions: [{ name: "network-fetch", required: false, reason: "Sync designs" }],
    },
    source: "registry",
    packagePath: "/profile/apps/com.acme.figma/1.0.0",
    sha256: "a".repeat(64),
    installedAt: "2026-08-01T00:00:00.000Z",
  };
}

function fixture() {
  let state: AppInstallationState = createEmptyAppInstallationState();
  const store = {
    snapshot: () => state,
    mutate: vi.fn(async (transition: (current: AppInstallationState) => AppInstallationState) => {
      state = transition(state);
      return state;
    }),
  };
  const lifecycle = {
    enable: vi.fn(async (appId: string, spaceId: string) => {
      const current = state.spaceStateByKey[spaceId + "\0" + appId];
      state = {
        ...state,
        spaceStateByKey: {
          ...state.spaceStateByKey,
          [spaceId + "\0" + appId]: { appId, spaceId, enabled: true, permissions: current?.permissions ?? {} },
        },
      };
      return state;
    }),
    disable: vi.fn(async (appId: string, spaceId: string) => {
      const key = spaceId + "\0" + appId;
      const current = state.spaceStateByKey[key];
      state = {
        ...state,
        spaceStateByKey: {
          ...state.spaceStateByKey,
          [key]: { appId, spaceId, enabled: false, permissions: current?.permissions ?? {} },
        },
      };
      return state;
    }),
    isActive: vi.fn(() => false),
  };
  const updates = {
    prepare: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
  };
  return {
    service: new AppInstallationService({ store, lifecycle, updates }),
    lifecycle,
    updates,
    state: () => state,
  };
}

describe("AppInstallationService", () => {
  it("commits a verified registry package and reviewed Space grants before activation", async () => {
    const test = fixture();

    await test.service.installForSpace({
      package: { ...verifiedPackage(), source: "registry" },
      spaceId: "personal",
      permissions: { "network-fetch": "granted" },
    });

    expect(test.lifecycle.enable).toHaveBeenCalledWith("com.acme.figma", "personal");
    expect(test.state().packagesByAppId["com.acme.figma"]).toBeDefined();
    expect(test.state().spaceStateByKey["personal\0com.acme.figma"]).toMatchObject({
      enabled: true,
      permissions: { "network-fetch": "granted" },
    });
  });
  it("publishes package and Space changes through one trusted owner", async () => {
    const test = fixture();
    const listener = vi.fn();
    test.service.subscribe(listener);

    await test.service.install(verifiedPackage());
    await test.service.setEnabled({ appId: "com.acme.figma", spaceId: "personal", enabled: true });
    await test.service.setPermission({
      appId: "com.acme.figma",
      spaceId: "personal",
      permission: "network-fetch",
      grant: "granted",
    });

    expect(test.lifecycle.enable).toHaveBeenCalledWith("com.acme.figma", "personal");
    expect(test.state().spaceStateByKey["personal\0com.acme.figma"]).toMatchObject({
      enabled: true,
      permissions: { "network-fetch": "granted" },
    });
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("requires declared required grants before enabling an App", async () => {
    const test = fixture();
    const packageWithPermission = verifiedPackage();
    packageWithPermission.manifest.permissions = [{
      name: "network-fetch",
      required: true,
      reason: "Sync designs",
    }];
    await test.service.install(packageWithPermission);

    await expect(test.service.setEnabled({
      appId: "com.acme.figma",
      spaceId: "personal",
      enabled: true,
    })).rejects.toThrow("must be granted");
    expect(test.lifecycle.enable).not.toHaveBeenCalled();
  });

  it("restarts enabled Spaces on update and applies an exact permission review", async () => {
    const test = fixture();
    await test.service.install(verifiedPackage());
    await test.service.setEnabled({ appId: "com.acme.figma", spaceId: "personal", enabled: true });
    const update = verifiedPackage();
    update.manifest.version = "2.0.0";
    update.manifest.permissions = [{ name: "network-fetch", required: true, reason: "Sync designs" }];

    await test.service.updateForSpaces({
      package: { ...update, source: "registry" },
      permissionsBySpace: { personal: { "network-fetch": "granted" } },
    });

    expect(test.lifecycle.disable).toHaveBeenCalledWith("com.acme.figma", "personal");
    expect(test.lifecycle.enable).toHaveBeenLastCalledWith("com.acme.figma", "personal");
    expect(test.state().packagesByAppId["com.acme.figma"]?.version).toBe("2.0.0");
    expect(test.state().spaceStateByKey["personal\0com.acme.figma"]).toMatchObject({
      enabled: true,
      permissions: { "network-fetch": "granted" },
    });
    expect(test.updates.prepare).toHaveBeenCalledWith(expect.objectContaining({
      appId: "com.acme.figma",
      targetVersion: "2.0.0",
      previousState: expect.objectContaining({ packagesByAppId: expect.any(Object) }),
    }));
    expect(test.updates.clear).toHaveBeenCalledOnce();
  });

  it("requires an explicit grant or denial for every new permission in an enabled Space", async () => {
    const test = fixture();
    const initial = verifiedPackage();
    initial.manifest.permissions = [];
    await test.service.install(initial);
    await test.service.setEnabled({ appId: "com.acme.figma", spaceId: "personal", enabled: true });
    const update = verifiedPackage();
    update.manifest.version = "2.0.0";

    await expect(test.service.updateForSpaces({
      package: { ...update, source: "registry" },
      permissionsBySpace: {},
    })).rejects.toThrow("network-fetch must be reviewed for Space personal");
    expect(test.updates.prepare).not.toHaveBeenCalled();

    await expect(test.service.updateForSpaces({
      package: { ...update, source: "registry" },
      permissionsBySpace: { personal: { "network-fetch": "denied" } },
    })).resolves.toMatchObject({ packagesByAppId: { "com.acme.figma": { version: "2.0.0" } } });
  });

  it("restores the prior package and runtime when updated activation fails", async () => {
    const test = fixture();
    await test.service.install(verifiedPackage());
    await test.service.setEnabled({ appId: "com.acme.figma", spaceId: "personal", enabled: true });
    const update = verifiedPackage();
    update.manifest.version = "2.0.0";
    test.lifecycle.enable.mockRejectedValueOnce(new Error("new controller failed"));

    await expect(test.service.updateForSpaces({
      package: { ...update, source: "registry" },
      permissionsBySpace: {},
    })).rejects.toThrow("new controller failed");

    expect(test.state().packagesByAppId["com.acme.figma"]?.version).toBe("1.0.0");
    expect(test.state().spaceStateByKey["personal\0com.acme.figma"]?.enabled).toBe(true);
    expect(test.lifecycle.enable).toHaveBeenLastCalledWith("com.acme.figma", "personal");
    expect(test.updates.clear).toHaveBeenCalledOnce();
  });

  it("rolls back when the durable journal cannot be cleared at commit", async () => {
    const test = fixture();
    await test.service.install(verifiedPackage());
    await test.service.setEnabled({ appId: "com.acme.figma", spaceId: "personal", enabled: true });
    const update = verifiedPackage();
    update.manifest.version = "2.0.0";
    test.updates.clear.mockRejectedValueOnce(new Error("journal fsync failed"));

    await expect(test.service.updateForSpaces({
      package: { ...update, source: "registry" },
      permissionsBySpace: {},
    })).rejects.toThrow("journal fsync failed");

    expect(test.state().packagesByAppId["com.acme.figma"]?.version).toBe("1.0.0");
    expect(test.state().spaceStateByKey["personal\0com.acme.figma"]?.enabled).toBe(true);
    expect(test.updates.clear).toHaveBeenCalledTimes(2);
  });

  it("deactivates every enabled Space before retaining an uninstalled App's data", async () => {
    const test = fixture();
    await test.service.install(verifiedPackage());
    await test.service.setEnabled({ appId: "com.acme.figma", spaceId: "personal", enabled: true });
    await test.service.setEnabled({ appId: "com.acme.figma", spaceId: "work", enabled: true });

    await test.service.uninstall({ appId: "com.acme.figma", retainData: true });

    expect(test.lifecycle.disable).toHaveBeenCalledWith("com.acme.figma", "personal");
    expect(test.lifecycle.disable).toHaveBeenCalledWith("com.acme.figma", "work");
    expect(test.state().packagesByAppId["com.acme.figma"]).toBeUndefined();
    expect(test.state().spaceStateByKey["personal\0com.acme.figma"]).toMatchObject({ enabled: false });
  });

  it("erases retained Space state only when explicitly requested", async () => {
    const test = fixture();
    await test.service.install(verifiedPackage());
    await test.service.setEnabled({ appId: "com.acme.figma", spaceId: "personal", enabled: true });

    await test.service.uninstall({ appId: "com.acme.figma", retainData: false });

    expect(test.state().packagesByAppId["com.acme.figma"]).toBeUndefined();
    expect(test.state().spaceStateByKey["personal\0com.acme.figma"]).toBeUndefined();
  });

  it("refuses to erase data while the package is still installed", async () => {
    const test = fixture();
    await test.service.install(verifiedPackage());
    await expect(test.service.removeData({ appId: "com.acme.figma" })).rejects.toThrow(
      "only be removed after",
    );
  });
});
