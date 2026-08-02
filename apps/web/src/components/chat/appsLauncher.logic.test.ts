import { describe, expect, it } from "vitest";

import { SpaceId } from "@penkra/contracts";

import { resolveAppsLauncherAction, resolveAppsLauncherSpaceId } from "./appsLauncher.logic";

describe("fixed Apps launcher", () => {
  it("opens Apps when no Apps tab exists", () => {
    expect(
      resolveAppsLauncherAction({ dockOpen: false, activePaneId: null, appsPaneId: null }),
    ).toEqual({ kind: "open" });
  });

  it("switches to an existing Apps tab and reopens a collapsed dock", () => {
    expect(
      resolveAppsLauncherAction({ dockOpen: true, activePaneId: "browser", appsPaneId: "apps" }),
    ).toEqual({ kind: "switch", paneId: "apps" });
    expect(
      resolveAppsLauncherAction({ dockOpen: false, activePaneId: "apps", appsPaneId: "apps" }),
    ).toEqual({ kind: "switch", paneId: "apps" });
  });

  it("collapses only when Apps is already active in an open dock", () => {
    expect(
      resolveAppsLauncherAction({ dockOpen: true, activePaneId: "apps", appsPaneId: "apps" }),
    ).toEqual({ kind: "collapse" });
  });

  it("uses a Space-scoped draft before the thread is persisted", () => {
    const draftSpaceId = SpaceId.makeUnsafe("space-draft");

    expect(resolveAppsLauncherSpaceId({ persistedSpaceId: null, draftSpaceId })).toBe(draftSpaceId);
  });

  it("prefers the persisted thread Space after promotion", () => {
    const persistedSpaceId = SpaceId.makeUnsafe("space-persisted");

    expect(
      resolveAppsLauncherSpaceId({
        persistedSpaceId,
        draftSpaceId: SpaceId.makeUnsafe("space-draft"),
      }),
    ).toBe(persistedSpaceId);
  });
});
