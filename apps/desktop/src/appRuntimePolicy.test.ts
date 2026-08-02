import * as Path from "node:path";

import { describe, expect, it } from "vitest";

import {
  APP_SESSION_PARTITION_PREFIX,
  createAppDocumentUrl,
  createAppOrigin,
  createAppRendererPreferences,
  createAppSessionPartition,
  decideAppNavigation,
  resolveAppPackagePath,
} from "./appRuntimePolicy";

describe("App runtime policy", () => {
  it("creates a stable origin and document URL for one App identity", () => {
    expect(createAppOrigin("com.penkra.apps")).toBe("penkra-app://com.penkra.apps");
    expect(createAppDocumentUrl("com.penkra.apps", "app.html")).toBe(
      "penkra-app://com.penkra.apps/app.html",
    );
    expect(() => createAppDocumentUrl("com.penkra.apps", "https://example.com/app.html")).toThrow(
      "safe package-relative path",
    );
    expect(() => createAppOrigin("Com.Penkra.Apps")).toThrow("lowercase reverse-domain");
  });

  it("isolates persistent partitions by both App and Space without exposing either identifier", () => {
    const personal = createAppSessionPartition("com.penkra.apps", "personal");
    const personalAgain = createAppSessionPartition("com.penkra.apps", "personal");
    const work = createAppSessionPartition("com.penkra.apps", "work");
    const otherApp = createAppSessionPartition("com.acme.linear", "personal");

    expect(personal).toBe(personalAgain);
    expect(new Set([personal, work, otherApp])).toHaveLength(3);
    expect(personal).toMatch(new RegExp(`^${APP_SESSION_PARTITION_PREFIX}[a-f0-9]{64}$`));
    expect(personal).not.toContain("personal");
    expect(personal).not.toContain("com.penkra.apps");
  });

  it("returns locked-down renderer preferences with a host-owned preload", () => {
    const preloadPath = Path.resolve("/trusted/app-preload.js");
    expect(
      createAppRendererPreferences({
        appId: "com.penkra.apps",
        spaceId: "personal",
        preloadPath,
      }),
    ).toEqual({
      partition: createAppSessionPartition("com.penkra.apps", "personal"),
      preload: preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      additionalArguments: ["--penkra-app-id=com.penkra.apps"],
    });
    expect(() =>
      createAppRendererPreferences({
        appId: "com.penkra.apps",
        spaceId: "personal",
        preloadPath: "relative-preload.js",
      }),
    ).toThrow("preloadPath must be absolute");
  });

  it("allows only navigation within the assigned App origin", () => {
    expect(decideAppNavigation("com.penkra.apps", "penkra-app://com.penkra.apps/settings"))
      .toMatchObject({ action: "allow" });
    expect(decideAppNavigation("com.penkra.apps", "penkra-app://com.acme.linear/issues")).toEqual({
      action: "deny",
      reason: "outside-app-origin",
    });
    expect(decideAppNavigation("com.penkra.apps", "https://penkra.com")).toEqual({
      action: "deny",
      reason: "outside-app-origin",
    });
    expect(decideAppNavigation("com.penkra.apps", "not a url")).toEqual({
      action: "deny",
      reason: "invalid-url",
    });
  });

  it("resolves documents under the verified package root and ignores URL query/fragment", () => {
    const root = Path.resolve("/profile/apps/com.penkra.apps/1.0.0");
    expect(
      resolveAppPackagePath(
        root,
        "com.penkra.apps",
        "penkra-app://com.penkra.apps/assets/icon%20large.svg?theme=dark#icon",
      ),
    ).toBe(Path.join(root, "assets", "icon large.svg"));
  });

  it("rejects encoded traversal, invalid encoding, NUL bytes, and non-App protocols", () => {
    const root = Path.resolve("/profile/apps/com.penkra.apps/1.0.0");
    expect(() =>
      resolveAppPackagePath(
        root,
        "com.penkra.apps",
        "penkra-app://com.penkra.apps/%2e%2e/secrets.txt",
      ),
    ).toThrow("escapes its verified package root");
    expect(() =>
      resolveAppPackagePath(root, "com.penkra.apps", "penkra-app://com.penkra.apps/%E0%A4%A"),
    ).toThrow("invalid percent encoding");
    expect(() =>
      resolveAppPackagePath(root, "com.penkra.apps", "penkra-app://com.penkra.apps/app%00.html"),
    ).toThrow("NUL byte");
    expect(() =>
      resolveAppPackagePath(
        root,
        "com.penkra.apps",
        "penkra-app://com.penkra.apps/%2e%2e%5csecrets.txt",
      ),
    ).toThrow("platform-dependent separator");
    expect(() =>
      resolveAppPackagePath(root, "com.penkra.apps", "file:///tmp/app.html"),
    ).toThrow("does not belong to its assigned App origin");
    expect(() =>
      resolveAppPackagePath(
        root,
        "com.penkra.apps",
        "penkra-app://com.acme.linear/app.html",
      ),
    ).toThrow(
      "does not belong to its assigned App origin",
    );
  });
});
