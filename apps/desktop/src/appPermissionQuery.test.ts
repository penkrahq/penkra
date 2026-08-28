import { describe, expect, it } from "vitest";

import {
  createEmptyAppInstallationState,
  registerVerifiedAppPackage,
  setSpaceAppPermission,
} from "./appInstallationState";
import { queryAppPermission } from "./appPermissionQuery";

function state() {
  let value = registerVerifiedAppPackage(
    createEmptyAppInstallationState(),
    {
      manifest: {
        id: "com.acme.linear",
        slug: "linear",
        name: "Linear",
        summary: "Manage issues.",
        version: "1.0.0",
        compatibility: { penkra: ">=0.8.0" },
        icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml" }],
        entrypoints: { tab: "app.html" },
        permissions: [{ name: "network-fetch", required: false, reason: "Sync issues" }],
      },
      source: "registry",
      packagePath: "/profile/apps/com.acme.linear/1.0.0",
      sha256: "a".repeat(64),
      installedAt: "2026-08-01T00:00:00.000Z",
    },
    "personal",
  );
  value = setSpaceAppPermission(value, {
    appId: "com.acme.linear",
    spaceId: "personal",
    permission: "network-fetch",
    grant: "granted",
  });
  return value;
}

describe("App permission query", () => {
  it("uses only the renderer-bound App installation and Space grant", () => {
    expect(
      queryAppPermission(
        state(),
        { appId: "com.acme.linear", spaceId: "personal" },
        "network-fetch",
      ),
    ).toEqual({ name: "network-fetch", declared: true, required: false, state: "granted" });
    expect(() =>
      queryAppPermission(state(), { appId: "com.acme.linear", spaceId: "work" }, "network-fetch"),
    ).toThrow("not installed");
  });

  it("does not reveal or grant undeclared and unsupported authority", () => {
    expect(
      queryAppPermission(
        state(),
        { appId: "com.acme.linear", spaceId: "personal" },
        "browser-session",
      ),
    ).toEqual({ name: "browser-session", declared: false, required: false, state: "denied" });
    expect(() =>
      queryAppPermission(
        state(),
        { appId: "com.acme.linear", spaceId: "personal" },
        "account-read",
      ),
    ).toThrow("unsupported permission");
  });
});
