import { FolderId, SpaceId, ThreadId } from "@penkra/contracts";
import { describe, expect, it } from "vitest";

import { resolveChatIndexRestoreRoute } from "../routes/-chatIndexRoute.logic";
import type { ServerWorkspacePaths } from "./serverWorkspacePaths";
import {
  isThreadReachableFromSpace,
  resolveSpaceSelectionTarget,
  type SpaceSelectionTarget,
} from "./spaceNavigation";
import type { Project, SidebarThreadSummary } from "../types";

const paths: ServerWorkspacePaths = {
  homeDir: null,
  chatWorkspaceRoot: null,
};

const workSpaceId = SpaceId.makeUnsafe("space-work");
const personalSpaceId = SpaceId.makeUnsafe("space-personal");

function project(input: { id: string; spaceId?: SpaceId }): Project {
  return {
    id: FolderId.makeUnsafe(input.id),
    name: input.id,
    remoteName: input.id,
    folderName: input.id,
    localName: null,
    cwd: `/tmp/${input.id}`,
    defaultModelSelection: null,
    expanded: false,
    spaceId: input.spaceId ?? personalSpaceId,
    scripts: [],
  };
}

function thread(input: { id: string; folderId: string }): SidebarThreadSummary {
  return {
    id: ThreadId.makeUnsafe(input.id),
    folderId: FolderId.makeUnsafe(input.folderId),
    title: input.id,
    modelSelection: { provider: "codex", model: "gpt-5" },
    session: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    latestTurn: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
  };
}

const personalProject = project({ id: "project-personal", spaceId: personalSpaceId });
const homeChatContainer = project({ id: "project-home" });
const personalThread = thread({ id: "thread-personal", folderId: "project-personal" });
const projectById = new Map([
  [personalProject.id, personalProject],
  [homeChatContainer.id, homeChatContainer],
]);

describe("selecting an empty Space", () => {
  // The user-visible symptom: clicking a Space in the switcher appeared to do nothing. Selecting
  // an empty Space fell through to the generic "/" restore, which reopened the *previous* Space's
  // thread, and useRouteSpaceSync then wrote that thread's Space back over the click.
  it("never lands on a thread belonging to another Space", () => {
    const target: SpaceSelectionTarget = resolveSpaceSelectionTarget({
      spaceId: workSpaceId,
      folders: [personalProject],
      projectById,
      threads: [personalThread],
      rememberedThreadId: null,
      rememberedFolderId: null,
      paths,
      sortThreads: (threads) => threads,
    });
    expect(target).toEqual({ kind: "empty", spaceId: workSpaceId });

    const restored = resolveChatIndexRestoreRoute({
      // The Space we just left is still the remembered route.
      lastThreadRoute: { threadId: personalThread.id },
      availableSplitViewIds: new Set(),
      threadIds: [personalThread.id],
      sidebarThreadSummaryById: { [personalThread.id]: { folderId: personalThread.folderId } },
      draftFolderIdByThreadId: new Map(),
      rememberedSplitViewThreadIds: undefined,
      landingSpace: {
        spaceId: target.kind === "empty" ? target.spaceId : null,
        projectById,
        workspacePaths: paths,
      },
    });
    expect(restored).toBeNull();
  });

  it("does not cross Spaces through a Chats folder", () => {
    const homeThread = thread({ id: "thread-home", folderId: "project-home" });
    expect(
      resolveChatIndexRestoreRoute({
        lastThreadRoute: { threadId: homeThread.id },
        availableSplitViewIds: new Set(),
        threadIds: [homeThread.id],
        sidebarThreadSummaryById: { [homeThread.id]: { folderId: homeThread.folderId } },
        draftFolderIdByThreadId: new Map(),
        rememberedSplitViewThreadIds: undefined,
        landingSpace: { spaceId: workSpaceId, projectById, workspacePaths: paths },
      }),
    ).toBeNull();
  });

  // The durable activeSpaceId can still be hydrating while the remembered route is already
  // available. Scoping unconditionally would drop the user out of the
  // Space they closed the app in, so a landing with no Space intent must not filter.
  it("restores the remembered route unscoped when the landing carries no Space intent", () => {
    expect(
      resolveChatIndexRestoreRoute({
        lastThreadRoute: { threadId: personalThread.id, splitViewId: "split-cross-space" },
        availableSplitViewIds: new Set(["split-cross-space"]),
        threadIds: [personalThread.id],
        sidebarThreadSummaryById: { [personalThread.id]: { folderId: personalThread.folderId } },
        draftFolderIdByThreadId: new Map(),
        // Unscoped startup preserves the remembered split without applying a Space policy.
        rememberedSplitViewThreadIds: undefined,
        landingSpace: null,
      }),
    ).toEqual({ threadId: personalThread.id, splitViewId: "split-cross-space" });
  });

  it("drops a split containing a thread from another Space while retaining its focused route", () => {
    const workProject = project({ id: "project-work", spaceId: workSpaceId });
    const workThread = thread({ id: "thread-work", folderId: "project-work" });
    const folders = new Map([...projectById, [workProject.id, workProject]]);

    expect(
      resolveChatIndexRestoreRoute({
        lastThreadRoute: { threadId: workThread.id, splitViewId: "split-cross-space" },
        availableSplitViewIds: new Set(["split-cross-space"]),
        threadIds: [workThread.id, personalThread.id],
        sidebarThreadSummaryById: {
          [workThread.id]: { folderId: workThread.folderId },
          [personalThread.id]: { folderId: personalThread.folderId },
        },
        draftFolderIdByThreadId: new Map(),
        rememberedSplitViewThreadIds: [workThread.id, personalThread.id],
        landingSpace: {
          spaceId: workSpaceId,
          projectById: folders,
          workspacePaths: paths,
        },
      }),
    ).toEqual({ threadId: workThread.id });
  });

  it("drops a split whose pane membership cannot be validated", () => {
    const workProject = project({ id: "project-work", spaceId: workSpaceId });
    const workThread = thread({ id: "thread-work", folderId: "project-work" });

    expect(
      resolveChatIndexRestoreRoute({
        lastThreadRoute: { threadId: workThread.id, splitViewId: "split-unresolved" },
        availableSplitViewIds: new Set(["split-unresolved"]),
        threadIds: [workThread.id],
        sidebarThreadSummaryById: {
          [workThread.id]: { folderId: workThread.folderId },
        },
        draftFolderIdByThreadId: new Map(),
        rememberedSplitViewThreadIds: undefined,
        landingSpace: {
          spaceId: workSpaceId,
          projectById: new Map([...projectById, [workProject.id, workProject]]),
          workspacePaths: paths,
        },
      }),
    ).toEqual({ threadId: workThread.id });
  });

  it("keeps a split when every populated pane is reachable from the selected Space", () => {
    const workProject = project({ id: "project-work", spaceId: workSpaceId });
    const firstThread = thread({ id: "thread-work-1", folderId: "project-work" });
    const secondThread = thread({ id: "thread-work-2", folderId: "project-work" });

    expect(
      resolveChatIndexRestoreRoute({
        lastThreadRoute: { threadId: firstThread.id, splitViewId: "split-work" },
        availableSplitViewIds: new Set(["split-work"]),
        threadIds: [firstThread.id, secondThread.id],
        sidebarThreadSummaryById: {
          [firstThread.id]: { folderId: firstThread.folderId },
          [secondThread.id]: { folderId: secondThread.folderId },
        },
        draftFolderIdByThreadId: new Map(),
        rememberedSplitViewThreadIds: [firstThread.id, secondThread.id],
        landingSpace: {
          spaceId: workSpaceId,
          projectById: new Map([...projectById, [workProject.id, workProject]]),
          workspacePaths: paths,
        },
      }),
    ).toEqual({ threadId: firstThread.id, splitViewId: "split-work" });
  });
});

describe("resolveSpaceSelectionTarget", () => {
  it("prefers the Space's remembered thread, then its remembered project, then its newest thread", () => {
    const workProject = project({ id: "project-work", spaceId: workSpaceId });
    const older = thread({ id: "thread-older", folderId: "project-work" });
    const newer = thread({ id: "thread-newer", folderId: "project-work" });
    const byId = new Map([...projectById, [workProject.id, workProject]]);
    const base = {
      spaceId: workSpaceId,
      folders: [personalProject, workProject],
      projectById: byId,
      threads: [personalThread, older, newer],
      paths,
      sortThreads: (threads: readonly SidebarThreadSummary[]) =>
        threads.toSorted((left, right) => right.id.localeCompare(left.id)),
    };

    expect(
      resolveSpaceSelectionTarget({
        ...base,
        rememberedThreadId: older.id,
        rememberedFolderId: null,
      }),
    ).toEqual({ kind: "thread", threadId: older.id });

    expect(
      resolveSpaceSelectionTarget({
        ...base,
        rememberedThreadId: null,
        rememberedFolderId: workProject.id,
      }),
    ).toEqual({ kind: "folder", folderId: workProject.id });

    expect(
      resolveSpaceSelectionTarget({ ...base, rememberedThreadId: null, rememberedFolderId: null }),
    ).toEqual({ kind: "thread", threadId: older.id });
  });

  it("ignores remembered context that no longer belongs to the Space", () => {
    expect(
      resolveSpaceSelectionTarget({
        spaceId: workSpaceId,
        folders: [personalProject],
        projectById,
        threads: [personalThread],
        // Both targets belong to another persisted Space.
        rememberedThreadId: personalThread.id,
        rememberedFolderId: personalProject.id,
        paths,
        sortThreads: (threads) => threads,
      }),
    ).toEqual({ kind: "empty", spaceId: workSpaceId });
  });
});

describe("isThreadReachableFromSpace", () => {
  it("fails closed on a project the client cannot resolve", () => {
    expect(isThreadReachableFromSpace({ project: undefined, spaceId: null, paths })).toBe(false);
  });
});
