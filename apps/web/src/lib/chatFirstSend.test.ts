// FILE: chatFirstSend.test.ts
// Purpose: Verifies first-send project routing for general chats and folder mentions.

import { type ContainerId } from "@penkra/contracts";
import { describe, expect, it } from "vitest";

import type { Project } from "../types";
import { resolveFirstSendTarget } from "./chatFirstSend";

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "project-home" as ContainerId,
    kind: "chat",
    name: "Home",
    remoteName: "Home",
    folderName: "tester",
    localName: null,
    cwd: "/Users/tester",
    defaultModelSelection: null,
    expanded: false,
    spaceId: null,
    scripts: [],
    ...overrides,
  };
}

describe("resolveFirstSendTarget", () => {
  it("creates a managed date/slug chat project for a plain general chat first send", () => {
    const result = resolveFirstSendTarget({
      activeProject: makeProject(),
      chatWorkspaceRoot: "/Users/tester/Documents/Penkra",
      createdAt: new Date(2026, 5, 11, 23, 30, 43),
      isFirstMessage: true,
      isHomeChatContainer: true,
      projects: [makeProject()],
      selectedWorkspaceRoot: null,
      title: "Yes it takes",
      titleSeed: "Yes, it takes all the skills!",
    });

    expect(result).toMatchObject({
      kind: "create-project",
      creation: {
        workspaceRoot: "/Users/tester/Documents/Penkra/2026-06-11/yes-it-takes-all-the-skills",
        title: "Yes it takes",
        kind: "chat",
        createWorkspaceRootIfMissing: true,
      },
    });
  });

  it("keeps folder mentions as ordinary projects", () => {
    const result = resolveFirstSendTarget({
      activeProject: makeProject(),
      chatWorkspaceRoot: "/Users/tester/Documents/Penkra",
      createdAt: new Date(2026, 5, 11, 23, 30, 43),
      isFirstMessage: true,
      isHomeChatContainer: true,
      projects: [makeProject()],
      selectedWorkspaceRoot: "/Users/tester/Developer/app",
      title: "Use app",
      titleSeed: "Use app",
    });

    expect(result).toMatchObject({
      kind: "create-project",
      creation: {
        workspaceRoot: "/Users/tester/Developer/app",
        title: "app",
        kind: "project",
        createWorkspaceRootIfMissing: false,
      },
    });
  });

  it("uses the current project outside a home chat first send", () => {
    const activeProject = makeProject({ id: "project-app" as ContainerId, kind: "project" });
    const result = resolveFirstSendTarget({
      activeProject,
      chatWorkspaceRoot: "/Users/tester/Documents/Penkra",
      createdAt: new Date(2026, 5, 11, 23, 30, 43),
      isFirstMessage: false,
      isHomeChatContainer: false,
      projects: [activeProject],
      selectedWorkspaceRoot: null,
      title: "Follow up",
      titleSeed: "Follow up",
    });

    expect(result).toMatchObject({
      kind: "current",
      target: {
        targetProjectId: "project-app",
        targetProjectKind: "project",
      },
    });
  });

  it("keeps a plain Folder first send in the Folder container", () => {
    const activeProject = makeProject({
      id: "project-folder" as ContainerId,
      kind: "project",
      name: "Folder",
      remoteName: "Folder",
      cwd: "/Users/tester/Documents/Penkra/Folder",
    });
    const result = resolveFirstSendTarget({
      activeProject,
      chatWorkspaceRoot: "/Users/tester/Documents/Penkra",
      createdAt: new Date(2026, 5, 11, 23, 30, 43),
      isFirstMessage: true,
      isHomeChatContainer: false,
      projects: [activeProject],
      selectedWorkspaceRoot: null,
      title: "Write content",
      titleSeed: "Write content",
    });

    expect(result).toMatchObject({
      kind: "current",
      target: {
        targetProjectId: "project-folder",
        targetProjectKind: "project",
        targetProjectCwd: "/Users/tester/Documents/Penkra/Folder",
      },
    });
  });

  it("keeps a Folder folder pick in the Folder container", () => {
    const activeProject = makeProject({
      id: "project-folder" as ContainerId,
      kind: "project",
      name: "Folder",
      remoteName: "Folder",
      cwd: "/Users/tester/Documents/Penkra/Folder",
    });
    const result = resolveFirstSendTarget({
      activeProject,
      chatWorkspaceRoot: "/Users/tester/Documents/Penkra",
      createdAt: new Date(2026, 5, 11, 23, 30, 43),
      isFirstMessage: true,
      isHomeChatContainer: false,
      projects: [activeProject],
      selectedWorkspaceRoot: "/Users/tester/Developer/app",
      title: "Use app",
      titleSeed: "Use app",
    });

    expect(result).toMatchObject({
      kind: "current",
      target: {
        targetProjectId: "project-folder",
        targetProjectKind: "project",
        targetProjectCwd: "/Users/tester/Documents/Penkra/Folder",
      },
    });
  });
});
