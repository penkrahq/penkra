import { ContainerId, type ModelSelection, SpaceId, ThreadId } from "@penkra/contracts";
import { describe, expect, it } from "vitest";
import { type ComposerThreadDraftState, type DraftThreadState } from "../composerDraftStore";
import {
  buildDraftThreadContextPatch,
  createActiveDraftThreadSnapshot,
  createActiveThreadSnapshot,
  createFreshDraftThreadSeed,
  hasDraftContextOverrides,
  resolveInheritedThreadContext,
  resolveRecentParentWorkingDirectory,
  resolveTerminalThreadCreationState,
  resolveThreadBootstrapPlan,
  shouldReuseActiveDraftThread,
} from "./threadBootstrap";

const PROJECT_ID = ContainerId.makeUnsafe("project-bootstrap");
const THREAD_ID = ThreadId.makeUnsafe("thread-bootstrap");

function modelSelection(
  provider: "codex" | "claudeAgent",
  model: string,
  options?: ModelSelection["options"],
): ModelSelection {
  return {
    provider,
    model,
    ...(options ? { options } : {}),
  } as ModelSelection;
}

function makeDraftThread(partial?: Partial<DraftThreadState>): DraftThreadState {
  return {
    projectId: PROJECT_ID,
    spaceId: null,
    createdAt: "2026-04-05T10:00:00.000Z",
    runtimeMode: "approval-required",
    interactionMode: "default",
    entryPoint: "terminal",
    branch: "feature/terminal-bootstrap",
    worktreePath: "/repo/.worktrees/terminal-bootstrap",
    envMode: "worktree",
    ...partial,
  };
}

function makeComposerDraftState(
  partial?: Partial<ComposerThreadDraftState>,
): ComposerThreadDraftState {
  return {
    prompt: "",
    promptHistorySavedDraft: null,
    images: [],
    files: [],
    nonPersistedImageIds: [],
    persistedAttachments: [],
    assistantSelections: [],
    terminalContexts: [],
    fileComments: [],
    pastedTexts: [],
    skills: [],
    mentions: [],
    queuedTurns: [],
    queuePaused: false,
    modelSelectionByProvider: {
      claudeAgent: modelSelection("claudeAgent", "claude-opus-4-6", { effort: "max" }),
    },
    activeProvider: "claudeAgent",
    runtimeMode: null,
    interactionMode: null,
    ...partial,
  };
}

describe("threadBootstrap", () => {
  it("inherits the newest physical folder used directly in the same Space", () => {
    const personalId = SpaceId.makeUnsafe("personal");
    const workId = SpaceId.makeUnsafe("work");
    expect(
      resolveRecentParentWorkingDirectory({
        projectId: PROJECT_ID,
        projectKind: "chat",
        spaceId: personalId,
        threads: [
          {
            projectId: PROJECT_ID,
            spaceId: personalId,
            workingDirectory: "/repo/older",
            createdAt: "2026-04-05T10:00:00.000Z",
          },
          {
            projectId: PROJECT_ID,
            spaceId: workId,
            workingDirectory: "/repo/other-space",
            createdAt: "2026-04-05T12:00:00.000Z",
          },
          {
            projectId: PROJECT_ID,
            spaceId: personalId,
            workingDirectory: "/repo/newer",
            createdAt: "2026-04-05T11:00:00.000Z",
          },
        ],
      }),
    ).toBe("/repo/newer");
  });

  it("inherits across every thread in the same virtual folder", () => {
    expect(
      resolveRecentParentWorkingDirectory({
        projectId: PROJECT_ID,
        projectKind: "project",
        spaceId: SpaceId.makeUnsafe("ignored-for-folder-parent"),
        threads: [
          {
            projectId: PROJECT_ID,
            spaceId: null,
            workingDirectory: "/repo/folder-parent",
            createdAt: "2026-04-05T10:00:00.000Z",
          },
        ],
      }),
    ).toBe("/repo/folder-parent");
  });
  it("detects when a draft context override is present", () => {
    expect(hasDraftContextOverrides()).toBe(false);
    expect(hasDraftContextOverrides({ branch: "feature/new-branch" })).toBe(true);
  });

  it("builds a draft patch only when overrides are provided", () => {
    expect(buildDraftThreadContextPatch("terminal")).toBeNull();
    expect(
      buildDraftThreadContextPatch("terminal", {
        branch: "feature/new-branch",
        worktreePath: "/repo/.worktrees/new-branch",
      }),
    ).toEqual({
      branch: "feature/new-branch",
      worktreePath: "/repo/.worktrees/new-branch",
      entryPoint: "terminal",
    });
    expect(
      buildDraftThreadContextPatch("terminal", {
        envMode: "local",
      }),
    ).toEqual({
      envMode: "local",
      worktreePath: null,
      entryPoint: "terminal",
    });
  });

  it("recognizes when the active route draft can be reused", () => {
    expect(
      shouldReuseActiveDraftThread({
        draftThread: makeDraftThread(),
        entryPoint: "terminal",
        projectId: PROJECT_ID,
        routeThreadId: THREAD_ID,
      }),
    ).toBe(true);
    expect(
      shouldReuseActiveDraftThread({
        draftThread: makeDraftThread({ entryPoint: "chat" }),
        entryPoint: "terminal",
        projectId: PROJECT_ID,
        routeThreadId: THREAD_ID,
      }),
    ).toBe(false);
  });

  it("resolves bootstrap precedence as route draft, then stored draft, then fresh", () => {
    expect(
      resolveThreadBootstrapPlan({
        storedDraftThread: { threadId: ThreadId.makeUnsafe("stored-thread"), ...makeDraftThread() },
        latestActiveDraftThread: makeDraftThread({ branch: "feature/route-draft" }),
        entryPoint: "terminal",
        projectId: PROJECT_ID,
        routeThreadId: THREAD_ID,
      }),
    ).toMatchObject({ kind: "route", threadId: THREAD_ID });
    expect(
      resolveThreadBootstrapPlan({
        storedDraftThread: { threadId: THREAD_ID, ...makeDraftThread() },
        latestActiveDraftThread: null,
        entryPoint: "terminal",
        projectId: PROJECT_ID,
        routeThreadId: null,
      }),
    ).toMatchObject({ kind: "stored", threadId: THREAD_ID });
    expect(
      resolveThreadBootstrapPlan({
        storedDraftThread: null,
        latestActiveDraftThread: null,
        entryPoint: "terminal",
        projectId: PROJECT_ID,
        routeThreadId: null,
      }),
    ).toEqual({ kind: "fresh" });
  });

  it("creates stable snapshots for active thread state", () => {
    expect(
      createActiveThreadSnapshot(
        {
          projectId: PROJECT_ID,
          modelSelection: modelSelection("codex", "gpt-5"),
          runtimeMode: "full-access",
          interactionMode: "default",
        },
        PROJECT_ID,
      ),
    ).toEqual({
      projectId: PROJECT_ID,
      modelSelection: modelSelection("codex", "gpt-5"),
      runtimeMode: "full-access",
      interactionMode: "default",
      envMode: undefined,
      lastKnownPr: null,
    });
    expect(createActiveDraftThreadSnapshot(makeDraftThread(), PROJECT_ID)).toEqual({
      ...makeDraftThread(),
      workingDirectory: null,
      lastKnownPr: null,
    });
  });

  it("lets an active draft override inherited branch and worktree context", () => {
    expect(
      resolveInheritedThreadContext({
        activeThread: {
          branch: "feature/server-thread",
          worktreePath: "/repo/.worktrees/server-thread",
          envMode: "worktree",
        },
        activeDraftThread: makeDraftThread({
          branch: "feature/draft-thread",
          worktreePath: "/repo/.worktrees/draft-thread",
          envMode: "worktree",
        }),
      }),
    ).toEqual({
      branch: "feature/draft-thread",
      worktreePath: "/repo/.worktrees/draft-thread",
      workingDirectory: null,
      envMode: "worktree",
    });
  });

  it("lets a local active draft clear active thread branch and worktree context", () => {
    expect(
      resolveInheritedThreadContext({
        activeThread: {
          branch: "feature/server-thread",
          worktreePath: "/repo/.worktrees/server-thread",
          envMode: "worktree",
        },
        activeDraftThread: makeDraftThread({
          branch: null,
          worktreePath: null,
          envMode: "local",
        }),
      }),
    ).toEqual({
      branch: null,
      worktreePath: null,
      workingDirectory: null,
      envMode: "local",
    });
  });

  it("derives inherited environment mode from the active thread when no draft exists", () => {
    expect(
      resolveInheritedThreadContext({
        activeThread: {
          branch: "feature/server-thread",
          worktreePath: "/repo/.worktrees/server-thread",
          envMode: undefined,
        },
        activeDraftThread: null,
      }),
    ).toEqual({
      branch: "feature/server-thread",
      worktreePath: "/repo/.worktrees/server-thread",
      workingDirectory: null,
      envMode: "worktree",
    });
  });

  it("builds the fresh draft seed from creation inputs", () => {
    expect(
      createFreshDraftThreadSeed({
        createdAt: "2026-04-05T10:00:00.000Z",
        entryPoint: "terminal",
        options: {
          branch: "feature/new-terminal",
          worktreePath: "/repo/.worktrees/new-terminal",
          envMode: "worktree",
        },
      }),
    ).toEqual({
      createdAt: "2026-04-05T10:00:00.000Z",
      spaceId: null,
      branch: "feature/new-terminal",
      worktreePath: "/repo/.worktrees/new-terminal",
      workingDirectory: null,
      envMode: "worktree",
      runtimeMode: "full-access",
      entryPoint: "terminal",
    });
  });

  it("prefers draft state when resolving terminal creation payloads", () => {
    expect(
      resolveTerminalThreadCreationState({
        activeDraftThread: null,
        activeThread: {
          projectId: PROJECT_ID,
          modelSelection: modelSelection("codex", "gpt-5"),
          runtimeMode: "full-access",
          interactionMode: "default",
        },
        draftComposerState: makeComposerDraftState(),
        draftThread: makeDraftThread(),
        options: undefined,
        projectDefaultModelSelection: modelSelection("codex", "gpt-5.4"),
        projectId: PROJECT_ID,
      }),
    ).toEqual({
      spaceId: null,
      modelSelection: modelSelection("claudeAgent", "claude-opus-4-6", {
        effort: "max",
      }),
      runtimeMode: "approval-required",
      interactionMode: "default",
      envMode: "worktree",
      branch: "feature/terminal-bootstrap",
      worktreePath: "/repo/.worktrees/terminal-bootstrap",
      workingDirectory: null,
      lastKnownPr: null,
    });
  });

  it("does not inherit plan mode from the previously active thread for a fresh creation", () => {
    expect(
      resolveTerminalThreadCreationState({
        activeDraftThread: null,
        activeThread: {
          projectId: PROJECT_ID,
          modelSelection: modelSelection("codex", "gpt-5"),
          runtimeMode: "full-access",
          interactionMode: "plan",
        },
        draftComposerState: makeComposerDraftState(),
        draftThread: null,
        options: undefined,
        projectDefaultModelSelection: modelSelection("codex", "gpt-5.4"),
        projectId: PROJECT_ID,
      }).interactionMode,
    ).toBe("default");
  });

  it("normalizes an explicit legacy draft plan mode when resolving terminal creation payloads", () => {
    expect(
      resolveTerminalThreadCreationState({
        activeDraftThread: null,
        activeThread: {
          projectId: PROJECT_ID,
          modelSelection: modelSelection("codex", "gpt-5"),
          runtimeMode: "full-access",
          interactionMode: "default",
        },
        draftComposerState: makeComposerDraftState(),
        draftThread: makeDraftThread({ interactionMode: "plan" }),
        options: undefined,
        projectDefaultModelSelection: modelSelection("codex", "gpt-5.4"),
        projectId: PROJECT_ID,
      }).interactionMode,
    ).toBe("default");
  });

  it("clears inherited worktree state when an explicit local env override is requested", () => {
    expect(
      resolveTerminalThreadCreationState({
        activeDraftThread: null,
        activeThread: {
          projectId: PROJECT_ID,
          modelSelection: modelSelection("codex", "gpt-5"),
          runtimeMode: "full-access",
          interactionMode: "default",
          envMode: "worktree",
        },
        draftComposerState: makeComposerDraftState(),
        draftThread: makeDraftThread(),
        options: {
          envMode: "local",
        },
        projectDefaultModelSelection: modelSelection("codex", "gpt-5.4"),
        projectId: PROJECT_ID,
      }),
    ).toMatchObject({
      envMode: "local",
      worktreePath: null,
      branch: "feature/terminal-bootstrap",
    });
  });
});
