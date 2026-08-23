import { SpaceId, type FolderId } from "@penkra/contracts";
import { describe, expect, it } from "vitest";

import type { Project } from "../types";
import {
  resolveCurrentProjectTargetId,
  resolveLatestProjectTargetId,
  resolveLatestProjectTargetIdWithFallback,
  resolveNewThreadTarget,
} from "./projectShortcutTargets";

const CURRENT_PROJECT_ID = "project-current" as FolderId;
const LATEST_PROJECT_ID = "project-latest" as FolderId;
const HOME_PROJECT_ID = "project-home" as FolderId;

function makeProject(id: FolderId): Project {
  return {
    id,
    spaceId: SpaceId.makeUnsafe("space-test"),
    name: id,
    remoteName: id,
    folderName: id,
    localName: null,
    cwd: `/workspace/${id}`,
    defaultModelSelection: null,
    expanded: false,
    scripts: [],
  };
}

describe("project shortcut targets", () => {
  const folders = [
    makeProject(CURRENT_PROJECT_ID),
    makeProject(LATEST_PROJECT_ID),
    makeProject(HOME_PROJECT_ID),
  ];

  it("prefers the focused ordinary project over the latest project", () => {
    expect(
      resolveNewThreadTarget({
        currentFolderId: resolveCurrentProjectTargetId(folders, CURRENT_PROJECT_ID),
        latestUsableFolderId: resolveLatestProjectTargetId(folders, LATEST_PROJECT_ID),
      }),
    ).toEqual({ folderId: CURRENT_PROJECT_ID, inheritContext: true });
  });

  it("uses the focused Chats folder like any other folder", () => {
    expect(
      resolveNewThreadTarget({
        currentFolderId: resolveCurrentProjectTargetId(folders, HOME_PROJECT_ID),
        latestUsableFolderId: resolveLatestProjectTargetId(folders, LATEST_PROJECT_ID),
      }),
    ).toEqual({ folderId: HOME_PROJECT_ID, inheritContext: true });
  });

  it("falls back to the latest ordinary project when nothing is focused", () => {
    expect(
      resolveNewThreadTarget({
        currentFolderId: resolveCurrentProjectTargetId(folders, null),
        latestUsableFolderId: resolveLatestProjectTargetId(folders, LATEST_PROJECT_ID),
      }),
    ).toEqual({ folderId: LATEST_PROJECT_ID, inheritContext: false });
  });

  it("accepts a Chats folder as the latest target", () => {
    expect(resolveLatestProjectTargetId(folders, HOME_PROJECT_ID)).toBe(HOME_PROJECT_ID);
  });

  it("returns no target for a stale latest project id", () => {
    expect(
      resolveNewThreadTarget({
        currentFolderId: null,
        latestUsableFolderId: resolveLatestProjectTargetId(folders, "project-deleted" as FolderId),
      }),
    ).toBeNull();
  });

  it("falls back to the most recently updated project in the supplied space", () => {
    const older = { ...makeProject(CURRENT_PROJECT_ID), updatedAt: "2026-07-15T10:00:00.000Z" };
    const newer = { ...makeProject(LATEST_PROJECT_ID), updatedAt: "2026-07-15T10:00:01.000Z" };

    expect(
      resolveLatestProjectTargetIdWithFallback(
        [older, newer],
        "project-from-another-space" as FolderId,
      ),
    ).toBe(LATEST_PROJECT_ID);
  });

  it("returns no target when no folders exist", () => {
    expect(
      resolveNewThreadTarget({
        currentFolderId: resolveCurrentProjectTargetId([], null),
        latestUsableFolderId: resolveLatestProjectTargetId([], null),
      }),
    ).toBeNull();
  });
});
