import { describe, expect, it, vi } from "vitest";

import type { AppInstallationState } from "./appInstallationState";
import {
  appOpenWithHandlerFingerprint,
  reconcileAppOpenWithPreferences,
} from "./appOpenWithReconciler";

function stateWithApps(
  apps: ReadonlyArray<{
    appId: string;
    slug: string;
    enabled?: boolean;
    handlers: ReadonlyArray<Record<string, unknown>>;
  }>,
): AppInstallationState {
  return {
    packagesByInstallationKey: Object.fromEntries(
      apps.map((app) => [
        `personal\0${app.appId}`,
        {
          appId: app.appId,
          slug: app.slug,
          manifest: { contributions: { handlers: app.handlers } },
        },
      ]),
    ),
    spaceStateByKey: Object.fromEntries(
      apps.map((app) => [
        `personal\0${app.appId}`,
        { appId: app.appId, spaceId: "personal", enabled: app.enabled !== false },
      ]),
    ),
  } as AppInstallationState;
}

describe("App Open With reconciliation", () => {
  it("selects the first enabled handler by the existing slug order", async () => {
    const setIfSystemDefault = vi.fn(async () => ({ files: {} }));
    const state = stateWithApps([
      {
        appId: "com.zeta.browser",
        slug: "zeta",
        handlers: [{ intent: "open-url", operation: "url.open", schemes: ["https"] }],
      },
      {
        appId: "com.alpha.browser",
        slug: "alpha",
        handlers: [{ intent: "open-url", operation: "url.open", schemes: ["http", "https"] }],
      },
      {
        appId: "com.penkra.explorer",
        slug: "explorer",
        handlers: [
          { intent: "open-directory", operation: "resources.open" },
          {
            intent: "open-file",
            operation: "resources.open",
            extensions: [".md", ".txt"],
          },
        ],
      },
      {
        appId: "com.penkra.notes",
        slug: "notes",
        handlers: [{ intent: "open-file", operation: "resources.open", extensions: [".MD"] }],
      },
    ]);

    await reconcileAppOpenWithPreferences({
      state,
      openWith: { setIfSystemDefault } as never,
    });

    expect(setIfSystemDefault.mock.calls).toEqual([
      ["open-url", "com.alpha.browser"],
      ["open-directory", "com.penkra.explorer"],
      ["open-file", "com.penkra.explorer", ".md"],
    ]);
  });

  it("ignores disabled handlers and file extensions with only one eligible App", async () => {
    const setIfSystemDefault = vi.fn(async () => ({ files: {} }));
    const state = stateWithApps([
      {
        appId: "com.penkra.explorer",
        slug: "explorer",
        handlers: [{ intent: "open-file", operation: "resources.open", extensions: [".txt"] }],
      },
      {
        appId: "com.acme.web",
        slug: "web",
        enabled: false,
        handlers: [{ intent: "open-url", operation: "url.open", schemes: ["https"] }],
      },
    ]);

    await reconcileAppOpenWithPreferences({
      state,
      openWith: { setIfSystemDefault } as never,
    });

    expect(setIfSystemDefault).not.toHaveBeenCalled();
  });

  it("fingerprints enabled handler topology without preference-unrelated state", () => {
    const state = stateWithApps([
      {
        appId: "com.penkra.browser",
        slug: "browser",
        handlers: [{ intent: "open-url", operation: "url.open", schemes: ["https"] }],
      },
    ]);
    const changedPermission = {
      ...state,
      spaceStateByKey: {
        ...state.spaceStateByKey,
        "personal\0com.penkra.browser": {
          ...state.spaceStateByKey["personal\0com.penkra.browser"]!,
          permissions: { "browser-session": "granted" as const },
        },
      },
    };

    expect(appOpenWithHandlerFingerprint(changedPermission)).toBe(
      appOpenWithHandlerFingerprint(state),
    );
  });
});
