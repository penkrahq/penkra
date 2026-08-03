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
  let unexpectedDisableListener:
    | ((event: {
        appId: string;
        spaceId: string;
        error: Error;
        state: AppInstallationState;
      }) => void)
    | undefined;
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
          [spaceId + "\0" + appId]: {
            appId,
            spaceId,
            enabled: true,
            permissions: current?.permissions ?? {},
            settings: current?.settings ?? {},
            settingMigrations: current?.settingMigrations ?? {},
            skills: current?.skills ?? {},
          },
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
          [key]: {
            appId,
            spaceId,
            enabled: false,
            permissions: current?.permissions ?? {},
            settings: current?.settings ?? {},
            settingMigrations: current?.settingMigrations ?? {},
            skills: current?.skills ?? {},
          },
        },
      };
      return state;
    }),
    isActive: vi.fn(() => false),
    subscribeUnexpectedDisable: vi.fn((listener) => {
      unexpectedDisableListener = listener;
      return vi.fn();
    }),
  };
  const updates = {
    prepare: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
  };
  const data = {
    eraseData: vi.fn(async () => undefined),
  };
  const secrets = new Map<string, string>();
  const settingSecrets = {
    getSecret: vi.fn(
      (appId: string, spaceId: string, name: string) =>
        secrets.get(`${appId}\0${spaceId}\0${name}`) ?? null,
    ),
    setSecret: vi.fn(async (appId: string, spaceId: string, name: string, value: string) => {
      secrets.set(`${appId}\0${spaceId}\0${name}`, value);
    }),
    deleteSecret: vi.fn(async (appId: string, spaceId: string, name: string) => {
      secrets.delete(`${appId}\0${spaceId}\0${name}`);
    }),
  };
  return {
    service: new AppInstallationService({ store, lifecycle, data, updates, settingSecrets }),
    data,
    lifecycle,
    updates,
    settingSecrets,
    unexpectedDisable: (error = new Error("controller crashed")) =>
      unexpectedDisableListener?.({
        appId: "com.acme.figma",
        spaceId: "personal",
        error,
        state,
      }),
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
    expect(test.state().packagesByInstallationKey["personal\0com.acme.figma"]).toBeDefined();
    expect(test.state().spaceStateByKey["personal\0com.acme.figma"]).toMatchObject({
      enabled: true,
      permissions: { "network-fetch": "granted" },
    });
  });
  it("publishes package and Space changes through one trusted owner", async () => {
    const test = fixture();
    const listener = vi.fn();
    test.service.subscribe(listener);

    await test.service.install(verifiedPackage(), "personal");
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

  it("publishes lifecycle safe-disable state after a controller crash", async () => {
    const test = fixture();
    const listener = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    test.service.subscribe(listener);

    test.unexpectedDisable();

    expect(listener).toHaveBeenCalledWith(test.state());
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("Disabled com.acme.figma"),
      expect.any(Error),
    );
    consoleError.mockRestore();
  });

  it("requires declared required grants before enabling an App", async () => {
    const test = fixture();
    const packageWithPermission = verifiedPackage();
    packageWithPermission.manifest.permissions = [
      {
        name: "network-fetch",
        required: true,
        reason: "Sync designs",
      },
    ];
    await test.service.install(packageWithPermission, "personal");

    await expect(
      test.service.setEnabled({
        appId: "com.acme.figma",
        spaceId: "personal",
        enabled: true,
      }),
    ).rejects.toThrow("must be granted");
    expect(test.lifecycle.enable).not.toHaveBeenCalled();
  });

  it("revokes a required permission by disabling the App first", async () => {
    const test = fixture();
    const packageWithPermission = verifiedPackage();
    packageWithPermission.manifest.permissions = [
      {
        name: "network-fetch",
        required: true,
        reason: "Sync designs",
      },
    ];
    await test.service.install(packageWithPermission, "personal");
    await test.service.setPermission({
      appId: "com.acme.figma",
      spaceId: "personal",
      permission: "network-fetch",
      grant: "granted",
    });
    await test.service.setEnabled({ appId: "com.acme.figma", spaceId: "personal", enabled: true });

    await test.service.setPermission({
      appId: "com.acme.figma",
      spaceId: "personal",
      permission: "network-fetch",
      grant: "denied",
    });

    expect(test.lifecycle.disable).toHaveBeenCalledWith("com.acme.figma", "personal");
    expect(test.state().spaceStateByKey["personal\0com.acme.figma"]).toMatchObject({
      enabled: false,
      permissions: { "network-fetch": "denied" },
    });
  });

  it("coalesces concurrent optional permission requests into one prompt", async () => {
    const test = fixture();
    await test.service.install(verifiedPackage(), "personal");
    const confirm = vi.fn(async () => true);

    const first = test.service.requestOptionalPermission({
      appId: "com.acme.figma",
      spaceId: "personal",
      permission: "network-fetch",
      confirm,
    });
    const second = test.service.requestOptionalPermission({
      appId: "com.acme.figma",
      spaceId: "personal",
      permission: "network-fetch",
      confirm,
    });

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(confirm).toHaveBeenCalledOnce();
    expect(test.state().spaceStateByKey["personal\0com.acme.figma"]?.permissions).toEqual({
      "network-fetch": "granted",
    });
  });

  it("lets an explicit Settings change win over a permission prompt already in flight", async () => {
    const test = fixture();
    await test.service.install(verifiedPackage(), "personal");
    let resolvePrompt!: (value: boolean) => void;
    const prompt = new Promise<boolean>((resolve) => {
      resolvePrompt = resolve;
    });
    const request = test.service.requestOptionalPermission({
      appId: "com.acme.figma",
      spaceId: "personal",
      permission: "network-fetch",
      confirm: () => prompt,
    });
    await test.service.setPermission({
      appId: "com.acme.figma",
      spaceId: "personal",
      permission: "network-fetch",
      grant: "denied",
    });
    resolvePrompt(true);

    await request;
    expect(test.state().spaceStateByKey["personal\0com.acme.figma"]?.permissions).toEqual({
      "network-fetch": "denied",
    });
  });

  it("rejects runtime requests for required or undeclared permissions", async () => {
    const test = fixture();
    const packageWithRequiredPermission = verifiedPackage();
    packageWithRequiredPermission.manifest.permissions = [
      {
        name: "network-fetch",
        required: true,
        reason: "Sync designs",
      },
    ];
    await test.service.install(packageWithRequiredPermission, "personal");

    await expect(
      test.service.requestOptionalPermission({
        appId: "com.acme.figma",
        spaceId: "personal",
        permission: "network-fetch",
        confirm: async () => true,
      }),
    ).rejects.toThrow("required");
    await expect(
      test.service.requestOptionalPermission({
        appId: "com.acme.figma",
        spaceId: "personal",
        permission: "raw-socket",
        confirm: async () => true,
      }),
    ).rejects.toThrow("not declared");
  });

  it("persists validated plain Settings per Space and exposes defaults without storing them", async () => {
    const test = fixture();
    const app = verifiedPackage();
    app.manifest.contributions = {
      settings: [
        {
          key: "font-size",
          label: "Font size",
          type: "number",
          default: 14,
          migrationId: "font-size-v1",
          validation: { minimum: 10, maximum: 20, step: 2 },
        },
      ],
    };
    await test.service.install(app, "personal");

    expect(
      test.service.getSetting({ appId: app.manifest.id, spaceId: "personal", key: "font-size" }),
    ).toBe(14);
    expect(
      test.service.listSettings({ appId: app.manifest.id, spaceId: "personal" })[0],
    ).toMatchObject({
      configured: false,
      value: 14,
    });
    await expect(
      test.service.setSetting({
        appId: app.manifest.id,
        spaceId: "personal",
        key: "font-size",
        value: 15,
      }),
    ).rejects.toThrow("step of 2");
    await test.service.setSetting({
      appId: app.manifest.id,
      spaceId: "personal",
      key: "font-size",
      value: 18,
    });
    expect(
      test.service.getSetting({ appId: app.manifest.id, spaceId: "personal", key: "font-size" }),
    ).toBe(18);
    expect(test.state().spaceStateByKey["personal\0com.acme.figma"]).toMatchObject({
      settings: { "font-size": 18 },
      settingMigrations: { "font-size": "font-size-v1" },
      skills: {},
    });
  });

  it("keeps sensitive Settings only in the encrypted vault owner and resets them independently", async () => {
    const test = fixture();
    const app = verifiedPackage();
    app.manifest.contributions = {
      settings: [
        {
          key: "api-token",
          label: "API token",
          type: "string",
          default: "",
          sensitive: true,
        },
      ],
    };
    await test.service.install(app, "personal");
    await test.service.setSetting({
      appId: app.manifest.id,
      spaceId: "personal",
      key: "api-token",
      value: "secret-value",
    });

    expect(
      test.service.getSetting({ appId: app.manifest.id, spaceId: "personal", key: "api-token" }),
    ).toBe("secret-value");
    const sensitiveSnapshot = test.service.listSettings({
      appId: app.manifest.id,
      spaceId: "personal",
    })[0];
    expect(sensitiveSnapshot).toMatchObject({ configured: true });
    expect(sensitiveSnapshot).not.toHaveProperty("value");
    expect(test.state().spaceStateByKey["personal\0com.acme.figma"]?.settings).toEqual({});
    await test.service.resetSetting({
      appId: app.manifest.id,
      spaceId: "personal",
      key: "api-token",
    });
    expect(
      test.service.getSetting({ appId: app.manifest.id, spaceId: "personal", key: "api-token" }),
    ).toBe("");
  });

  it("restarts enabled Spaces on update and applies an exact permission review", async () => {
    const test = fixture();
    await test.service.install(verifiedPackage(), "personal");
    await test.service.setEnabled({ appId: "com.acme.figma", spaceId: "personal", enabled: true });
    const update = verifiedPackage();
    update.manifest.version = "2.0.0";
    update.manifest.permissions = [
      { name: "network-fetch", required: true, reason: "Sync designs" },
    ];

    await test.service.updateForSpace({
      package: { ...update, source: "registry" },
      spaceId: "personal",
      permissions: { "network-fetch": "granted" },
    });

    expect(test.lifecycle.disable).toHaveBeenCalledWith("com.acme.figma", "personal");
    expect(test.lifecycle.enable).toHaveBeenLastCalledWith("com.acme.figma", "personal");
    expect(test.state().packagesByInstallationKey["personal\0com.acme.figma"]?.version).toBe(
      "2.0.0",
    );
    expect(test.state().spaceStateByKey["personal\0com.acme.figma"]).toMatchObject({
      enabled: true,
      permissions: { "network-fetch": "granted" },
    });
    expect(test.updates.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: "com.acme.figma",
        spaceId: "personal",
        targetVersion: "2.0.0",
        previousState: expect.objectContaining({
          packagesByInstallationKey: expect.any(Object),
        }),
      }),
    );
    expect(test.updates.clear).toHaveBeenCalledOnce();
  });

  it("requires an explicit grant or denial for every new permission in an enabled Space", async () => {
    const test = fixture();
    const initial = verifiedPackage();
    initial.manifest.permissions = [];
    await test.service.install(initial, "personal");
    await test.service.setEnabled({ appId: "com.acme.figma", spaceId: "personal", enabled: true });
    const update = verifiedPackage();
    update.manifest.version = "2.0.0";

    await expect(
      test.service.updateForSpace({
        package: { ...update, source: "registry" },
        spaceId: "personal",
        permissions: {},
      }),
    ).rejects.toThrow("network-fetch must be reviewed for Space personal");
    expect(test.updates.prepare).not.toHaveBeenCalled();

    await expect(
      test.service.updateForSpace({
        package: { ...update, source: "registry" },
        spaceId: "personal",
        permissions: { "network-fetch": "denied" },
      }),
    ).resolves.toMatchObject({
      packagesByInstallationKey: {
        "personal\0com.acme.figma": { version: "2.0.0" },
      },
    });
  });

  it("restarts enabled Spaces when validated sideload bytes change", async () => {
    const test = fixture();
    const initial = { ...verifiedPackage(), source: "sideload" as const };
    await test.service.install(initial, "personal");
    await test.service.setEnabled({ appId: "com.acme.figma", spaceId: "personal", enabled: true });
    const update = { ...verifiedPackage(), source: "sideload" as const };
    update.manifest.version = "1.0.1-dev";
    update.sha256 = "b".repeat(64);

    await test.service.updateSideloadForSpace({ package: update, spaceId: "personal" });

    expect(test.lifecycle.disable).toHaveBeenCalledWith("com.acme.figma", "personal");
    expect(test.lifecycle.enable).toHaveBeenLastCalledWith("com.acme.figma", "personal");
    expect(test.state().packagesByInstallationKey["personal\0com.acme.figma"]).toMatchObject({
      source: "sideload",
      version: "1.0.1-dev",
      sha256: "b".repeat(64),
    });
  });

  it("restores the prior package and runtime when updated activation fails", async () => {
    const test = fixture();
    await test.service.install(verifiedPackage(), "personal");
    await test.service.setEnabled({ appId: "com.acme.figma", spaceId: "personal", enabled: true });
    const update = verifiedPackage();
    update.manifest.version = "2.0.0";
    test.lifecycle.enable.mockRejectedValueOnce(new Error("new controller failed"));

    await expect(
      test.service.updateForSpace({
        package: { ...update, source: "registry" },
        spaceId: "personal",
        permissions: {},
      }),
    ).rejects.toThrow("new controller failed");

    expect(test.state().packagesByInstallationKey["personal\0com.acme.figma"]?.version).toBe(
      "1.0.0",
    );
    expect(test.state().spaceStateByKey["personal\0com.acme.figma"]?.enabled).toBe(true);
    expect(test.lifecycle.enable).toHaveBeenLastCalledWith("com.acme.figma", "personal");
    expect(test.updates.clear).toHaveBeenCalledOnce();
  });

  it("rolls back when the durable journal cannot be cleared at commit", async () => {
    const test = fixture();
    await test.service.install(verifiedPackage(), "personal");
    await test.service.setEnabled({ appId: "com.acme.figma", spaceId: "personal", enabled: true });
    const update = verifiedPackage();
    update.manifest.version = "2.0.0";
    test.updates.clear.mockRejectedValueOnce(new Error("journal fsync failed"));

    await expect(
      test.service.updateForSpace({
        package: { ...update, source: "registry" },
        spaceId: "personal",
        permissions: {},
      }),
    ).rejects.toThrow("journal fsync failed");

    expect(test.state().packagesByInstallationKey["personal\0com.acme.figma"]?.version).toBe(
      "1.0.0",
    );
    expect(test.state().spaceStateByKey["personal\0com.acme.figma"]?.enabled).toBe(true);
    expect(test.updates.clear).toHaveBeenCalledTimes(2);
  });

  it("uninstalls only the selected Space and retains its data", async () => {
    const test = fixture();
    await test.service.install(verifiedPackage(), "personal");
    await test.service.install(verifiedPackage(), "work");
    await test.service.setEnabled({ appId: "com.acme.figma", spaceId: "personal", enabled: true });
    await test.service.setEnabled({ appId: "com.acme.figma", spaceId: "work", enabled: true });

    await test.service.uninstall({
      appId: "com.acme.figma",
      spaceId: "personal",
      retainData: true,
    });

    expect(test.lifecycle.disable).toHaveBeenCalledWith("com.acme.figma", "personal");
    expect(test.lifecycle.disable).not.toHaveBeenCalledWith("com.acme.figma", "work");
    expect(test.state().packagesByInstallationKey["personal\0com.acme.figma"]).toBeUndefined();
    expect(test.state().packagesByInstallationKey["work\0com.acme.figma"]).toBeDefined();
    expect(test.state().spaceStateByKey["personal\0com.acme.figma"]).toMatchObject({
      enabled: false,
    });
  });

  it("erases retained Space state only when explicitly requested", async () => {
    const test = fixture();
    await test.service.install(verifiedPackage(), "personal");
    await test.service.setEnabled({ appId: "com.acme.figma", spaceId: "personal", enabled: true });

    await test.service.uninstall({
      appId: "com.acme.figma",
      spaceId: "personal",
      retainData: false,
    });

    expect(test.state().packagesByInstallationKey["personal\0com.acme.figma"]).toBeUndefined();
    expect(test.state().spaceStateByKey["personal\0com.acme.figma"]).toBeUndefined();
    expect(test.data.eraseData).toHaveBeenCalledWith("com.acme.figma", "personal");
  });

  it("keeps retained data when uninstall requests retention", async () => {
    const test = fixture();
    await test.service.install(verifiedPackage(), "personal");
    await test.service.setEnabled({ appId: "com.acme.figma", spaceId: "personal", enabled: true });

    await test.service.uninstall({
      appId: "com.acme.figma",
      spaceId: "personal",
      retainData: true,
    });

    expect(test.data.eraseData).not.toHaveBeenCalled();
    expect(test.state().spaceStateByKey["personal\0com.acme.figma"]).toBeDefined();
  });

  it("does not remove package metadata when persistent data erasure fails", async () => {
    const test = fixture();
    await test.service.install(verifiedPackage(), "personal");
    await test.service.setEnabled({ appId: "com.acme.figma", spaceId: "personal", enabled: true });
    test.data.eraseData.mockRejectedValueOnce(new Error("partition clear failed"));

    await expect(
      test.service.uninstall({
        appId: "com.acme.figma",
        spaceId: "personal",
        retainData: false,
      }),
    ).rejects.toThrow("partition clear failed");

    expect(test.state().packagesByInstallationKey["personal\0com.acme.figma"]).toBeDefined();
    expect(test.state().spaceStateByKey["personal\0com.acme.figma"]).toBeDefined();
  });

  it("erases one retained Space partition after uninstall", async () => {
    const test = fixture();
    await test.service.install(verifiedPackage(), "personal");
    await test.service.install(verifiedPackage(), "work");
    await test.service.setEnabled({ appId: "com.acme.figma", spaceId: "personal", enabled: true });
    await test.service.setEnabled({ appId: "com.acme.figma", spaceId: "work", enabled: true });
    await test.service.uninstall({
      appId: "com.acme.figma",
      spaceId: "personal",
      retainData: true,
    });

    await test.service.removeData({ appId: "com.acme.figma", spaceId: "personal" });

    expect(test.data.eraseData).toHaveBeenCalledWith("com.acme.figma", "personal");
    expect(test.data.eraseData).not.toHaveBeenCalledWith("com.acme.figma", "work");
    expect(test.state().spaceStateByKey["personal\0com.acme.figma"]).toBeUndefined();
    expect(test.state().spaceStateByKey["work\0com.acme.figma"]).toBeDefined();
  });

  it("refuses to erase data while the package is still installed", async () => {
    const test = fixture();
    await test.service.install(verifiedPackage(), "personal");
    await expect(
      test.service.removeData({ appId: "com.acme.figma", spaceId: "personal" }),
    ).rejects.toThrow("only be removed after");
  });
});
