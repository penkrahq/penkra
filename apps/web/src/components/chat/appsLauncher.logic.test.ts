import { describe, expect, it } from "vitest";

import { SpaceId } from "@penkra/contracts";
import { WINDOWS_CAPTION_CONTROLS_GUTTER_PX } from "@penkra/shared/desktopChrome";

import {
  resolveAppsLauncherAction,
  resolveAppsLauncherDeckBarReservationPx,
  resolveAppsLauncherRightInsetPx,
  resolveAppsLauncherSpaceId,
} from "./appsLauncher.logic";

describe("fixed Apps launcher", () => {
  it("clears the Windows caption-button cluster in Electron", () => {
    expect(resolveAppsLauncherRightInsetPx({ isElectron: true, isWindowsDesktop: true })).toBe(144);
    expect(resolveAppsLauncherRightInsetPx({ isElectron: true, isWindowsDesktop: false })).toBe(6);
  });

  it("reserves the launcher footprint on web and Windows using one maximum", () => {
    expect(
      resolveAppsLauncherDeckBarReservationPx({
        appsLauncherRightInsetPx: 6,
        dockOpen: false,
        isElectron: false,
        isWindowsDesktop: false,
      }),
    ).toBe(42);
    expect(
      resolveAppsLauncherDeckBarReservationPx({
        appsLauncherRightInsetPx: 144,
        dockOpen: false,
        isElectron: true,
        isWindowsDesktop: true,
      }),
    ).toBe(180);
    expect(144 + 32 + 4 + WINDOWS_CAPTION_CONTROLS_GUTTER_PX).toBe(318);
  });

  it("keeps only the existing Windows controls gutter while the dock is open", () => {
    expect(
      resolveAppsLauncherDeckBarReservationPx({
        appsLauncherRightInsetPx: 144,
        dockOpen: true,
        isElectron: true,
        isWindowsDesktop: true,
      }),
    ).toBe(WINDOWS_CAPTION_CONTROLS_GUTTER_PX);
    expect(
      resolveAppsLauncherDeckBarReservationPx({
        appsLauncherRightInsetPx: 6,
        dockOpen: true,
        isElectron: false,
        isWindowsDesktop: false,
      }),
    ).toBe(0);
  });

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

    expect(
      resolveAppsLauncherSpaceId({
        persistedSpaceId: null,
        draftSpaceId,
        projectSpaceId: SpaceId.makeUnsafe("space-project"),
      }),
    ).toBe(draftSpaceId);
  });

  it("prefers the persisted thread Space after promotion", () => {
    const persistedSpaceId = SpaceId.makeUnsafe("space-persisted");

    expect(
      resolveAppsLauncherSpaceId({
        persistedSpaceId,
        draftSpaceId: SpaceId.makeUnsafe("space-draft"),
        projectSpaceId: SpaceId.makeUnsafe("space-project"),
      }),
    ).toBe(persistedSpaceId);
  });

  it("inherits the parent Folder Space for persisted Folder threads", () => {
    const projectSpaceId = SpaceId.makeUnsafe("space-project");

    expect(
      resolveAppsLauncherSpaceId({
        persistedSpaceId: null,
        draftSpaceId: null,
        projectSpaceId,
      }),
    ).toBe(projectSpaceId);
  });
});
