import type { ContainerId } from "@penkra/contracts";
import { describe, expect, it } from "vitest";

import type { Project } from "../types";
import {
  resolveCurrentProjectTargetId,
  resolveLatestProjectTargetId,
  resolveLatestProjectTargetIdWithFallback,
  resolveNewThreadTarget,
} from "./projectShortcutTargets";

const CURRENT_PROJECT_ID = "project-current" as ContainerId;
const LATEST_PROJECT_ID = "project-latest" as ContainerId;
const HOME_PROJECT_ID = "project-home" as ContainerId;

function makeProject(id: ContainerId, kind: Project["kind"] = "project"): Project {
  return {
    id,
    kind,
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
  const projects = [
    makeProject(CURRENT_PROJECT_ID),
    makeProject(LATEST_PROJECT_ID),
    makeProject(HOME_PROJECT_ID, "chat"),
  ];

  it("prefers the focused ordinary project over the latest project", () => {
    expect(
      resolveNewThreadTarget({
        currentProjectId: resolveCurrentProjectTargetId(projects, CURRENT_PROJECT_ID),
        latestUsableProjectId: resolveLatestProjectTargetId(projects, LATEST_PROJECT_ID),
      }),
    ).toEqual({ projectId: CURRENT_PROJECT_ID, inheritContext: true });
  });

  it("falls back to the latest ordinary project when Home is focused", () => {
    expect(
      resolveNewThreadTarget({
        currentProjectId: resolveCurrentProjectTargetId(projects, HOME_PROJECT_ID),
        latestUsableProjectId: resolveLatestProjectTargetId(projects, LATEST_PROJECT_ID),
      }),
    ).toEqual({ projectId: LATEST_PROJECT_ID, inheritContext: false });
  });

  it("falls back to the latest ordinary project when nothing is focused", () => {
    expect(
      resolveNewThreadTarget({
        currentProjectId: resolveCurrentProjectTargetId(projects, null),
        latestUsableProjectId: resolveLatestProjectTargetId(projects, LATEST_PROJECT_ID),
      }),
    ).toEqual({ projectId: LATEST_PROJECT_ID, inheritContext: false });
  });

  it("rejects a managed-chat latest project target", () => {
    expect(resolveLatestProjectTargetId(projects, HOME_PROJECT_ID)).toBeNull();
  });

  it("returns no target for a stale latest project id", () => {
    expect(
      resolveNewThreadTarget({
        currentProjectId: null,
        latestUsableProjectId: resolveLatestProjectTargetId(
          projects,
          "project-deleted" as ContainerId,
        ),
      }),
    ).toBeNull();
  });

  it("falls back to the most recently updated project in the supplied space", () => {
    const older = { ...makeProject(CURRENT_PROJECT_ID), updatedAt: "2026-07-15T10:00:00.000Z" };
    const newer = { ...makeProject(LATEST_PROJECT_ID), updatedAt: "2026-07-15T10:00:01.000Z" };

    expect(
      resolveLatestProjectTargetIdWithFallback(
        [older, newer],
        "project-from-another-space" as ContainerId,
      ),
    ).toBe(LATEST_PROJECT_ID);
  });

  it("returns no target when no projects exist", () => {
    expect(
      resolveNewThreadTarget({
        currentProjectId: resolveCurrentProjectTargetId([], null),
        latestUsableProjectId: resolveLatestProjectTargetId([], null),
      }),
    ).toBeNull();
  });
});
