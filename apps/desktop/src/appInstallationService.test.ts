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
      state = {
        ...state,
        spaceStateByKey: {
          ...state.spaceStateByKey,
          [spaceId + "\0" + appId]: { appId, spaceId, enabled: true, permissions: {} },
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
  return {
    service: new AppInstallationService({ store, lifecycle }),
    lifecycle,
    state: () => state,
  };
}

describe("AppInstallationService", () => {
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
