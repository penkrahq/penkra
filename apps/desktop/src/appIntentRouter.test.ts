import { describe, expect, it } from "vitest";

import {
  createEmptyAppInstallationState,
  registerVerifiedAppPackage,
  setSpaceAppEnabled,
  type AppInstallationState,
} from "./appInstallationState";
import { AppIntentRouter } from "./appIntentRouter";

function addBrowser(state: AppInstallationState, id: string, slug: string, spaceId: string) {
  let next = registerVerifiedAppPackage(
    state,
    {
      manifest: {
        manifestVersion: 2,
        id,
        slug,
        name: slug,
        summary: "Open URLs.",
        version: "1.0.0",
        compatibility: { penkra: ">=0.8.0" },
        icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml" }],
        entrypoints: { app: "app.html", operations: "operations.js" },
        operations: [
          {
            key: "url.open",
            summary: "Open a URL.",
            input: { type: "object" },
            output: { type: "object" },
            examples: [{ name: "Open a URL", input: {} }],
            handler: "url.open",
          },
        ],
        contributions: {
          handlers: [{ intent: "open-url", operation: "url.open", schemes: ["https"] }],
        },
      },
      source: "registry",
      packagePath: `/apps/${id}`,
      sha256: (slug === "browser" ? "a" : "b").repeat(64),
      installedAt: "2026-08-02T00:00:00.000Z",
    },
    spaceId,
  );
  next = setSpaceAppEnabled(next, { appId: id, spaceId, enabled: true });
  return next;
}

function addFileApp(
  state: AppInstallationState,
  id: string,
  slug: string,
  spaceId: string,
  extensions: string[],
) {
  let next = registerVerifiedAppPackage(
    state,
    {
      manifest: {
        manifestVersion: 2,
        id,
        slug,
        name: slug,
        summary: "Open files.",
        version: "1.0.0",
        compatibility: { penkra: ">=0.8.0" },
        icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml" }],
        entrypoints: { app: "app.html", operations: "operations.js" },
        operations: [
          {
            key: "resources.open",
            summary: "Open a resource.",
            input: { type: "object" },
            output: { type: "object" },
            examples: [{ name: "Open a resource", input: {} }],
            handler: "resources.open",
          },
        ],
        contributions: {
          handlers: [
            { intent: "open-file", operation: "resources.open", extensions },
            { intent: "open-directory", operation: "resources.open" },
          ],
        },
      },
      source: "registry",
      packagePath: `/apps/${id}`,
      sha256: "c".repeat(64),
      installedAt: "2026-08-02T00:00:00.000Z",
    },
    spaceId,
  );
  next = setSpaceAppEnabled(next, { appId: id, spaceId, enabled: true });
  return next;
}

describe("App intent router", () => {
  it("resolves only enabled compatible handlers in the explicit Space", () => {
    const state = addBrowser(
      createEmptyAppInstallationState(),
      "com.penkra.browser",
      "browser",
      "personal",
    );
    const router = new AppIntentRouter(() => state);
    expect(
      router.resolve("personal", { intent: "open-url", url: "https://penkra.com" }),
    ).toBeNull();
    expect(
      router.resolve("personal", {
        intent: "open-url",
        url: "https://penkra.com",
        requestedApp: "browser",
      }),
    ).toMatchObject({ appId: "com.penkra.browser", operation: "url.open" });
    expect(router.resolve("work", { intent: "open-url", url: "https://penkra.com" })).toBeNull();
  });

  it("uses a saved preference without introducing an interactive ambiguity state", () => {
    let state = addBrowser(
      createEmptyAppInstallationState(),
      "com.penkra.browser",
      "browser",
      "personal",
    );
    state = addBrowser(state, "com.acme.web", "web", "personal");
    const router = new AppIntentRouter(() => state);
    expect(
      router.resolve("personal", { intent: "open-url", url: "https://penkra.com" }),
    ).toBeNull();
    expect(
      router.resolve("personal", {
        intent: "open-url",
        url: "https://penkra.com",
        preferredAppId: "com.acme.web",
      })?.slug,
    ).toBe("web");
    expect(() =>
      router.resolve("personal", {
        intent: "open-url",
        url: "https://penkra.com",
        requestedApp: "missing",
      }),
    ).toThrow(expect.objectContaining({ code: "requested-handler-unavailable" }));
  });

  it("routes exact file extensions and directories through one compatible App", () => {
    const state = addFileApp(
      createEmptyAppInstallationState(),
      "com.penkra.explorer",
      "explorer",
      "personal",
      [".md", ".txt"],
    );
    const router = new AppIntentRouter(() => state);

    expect(router.resolve("personal", { intent: "open-file", extension: ".MD" })?.slug).toBe(
      "explorer",
    );
    expect(router.resolve("personal", { intent: "open-directory" })?.slug).toBe("explorer");
    expect(router.resolve("personal", { intent: "open-file", extension: ".pdf" })).toBeNull();
  });

  it("requires a preference when multiple file handlers match", () => {
    let state = addFileApp(
      createEmptyAppInstallationState(),
      "com.penkra.explorer",
      "explorer",
      "personal",
      [".md"],
    );
    state = addFileApp(state, "com.acme.notes", "notes", "personal", [".md"]);
    const router = new AppIntentRouter(() => state);

    expect(router.resolve("personal", { intent: "open-file", extension: ".md" })).toBeNull();
    expect(
      router.resolve("personal", {
        intent: "open-file",
        extension: ".md",
        preferredAppId: "com.penkra.explorer",
      })?.slug,
    ).toBe("explorer");
  });
});
