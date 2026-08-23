import { FolderId, type ModelSelection, SpaceId, ThreadId } from "@penkra/contracts";
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
  requireNewThreadSpaceId,
  scopeNewThreadOptionsToContainer,
  scopeNewThreadOptionsToParentSpace,
  resolveTerminalThreadCreationState,
  resolveThreadBootstrapPlan,
  shouldReuseActiveDraftThread,
} from "./threadBootstrap";

const PROJECT_ID = FolderId.makeUnsafe("project-bootstrap");
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
    folderId: PROJECT_ID,
    spaceId: null,
    createdAt: "2026-04-05T10:00:00.000Z",
    runtimeMode: "approval-required",
    entryPoint: "terminal",
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
    ...partial,
  };
}

describe("threadBootstrap", () => {
  it("requires the selected top-parent Space when persisting a new Thread", () => {
    const personalId = SpaceId.makeUnsafe("personal");
    expect(requireNewThreadSpaceId(personalId)).toBe(personalId);
    expect(() => requireNewThreadSpaceId(null)).toThrow(
      "Choose a persisted Space before starting this chat.",
    );
  });

  it("uses the virtual Folder's owning Space for a new Thread", () => {
    const personalId = SpaceId.makeUnsafe("personal");
    expect(
      scopeNewThreadOptionsToParentSpace(
        { spaceId: SpaceId.makeUnsafe("stale-space") },
        personalId,
      ),
    ).toEqual({ spaceId: personalId });
  });

  it("uses the Folder's owning Space through container scoping", () => {
    const personalId = SpaceId.makeUnsafe("personal");
    const workId = SpaceId.makeUnsafe("work");
    expect(
      scopeNewThreadOptionsToContainer({
        options: { spaceId: workId },
        containerSpaceId: personalId,
      }),
    ).toEqual({ spaceId: personalId });
  });

  it("inherits the newest working directory used in the same Folder", () => {
    expect(
      resolveRecentParentWorkingDirectory({
        folderId: PROJECT_ID,
        threads: [
          {
            folderId: PROJECT_ID,
            workingDirectory: "/repo/older",
            createdAt: "2026-04-05T10:00:00.000Z",
          },
          {
            folderId: FolderId.makeUnsafe("other-folder"),
            workingDirectory: "/repo/other-space",
            createdAt: "2026-04-05T12:00:00.000Z",
          },
          {
            folderId: PROJECT_ID,
            workingDirectory: "/repo/newer",
            createdAt: "2026-04-05T11:00:00.000Z",
          },
        ],
      }),
    ).toBe("/repo/newer");
  });

  it("inherits across every thread in the Folder", () => {
    expect(
      resolveRecentParentWorkingDirectory({
        folderId: PROJECT_ID,
        threads: [
          {
            folderId: PROJECT_ID,
            workingDirectory: "/repo/folder-parent",
            createdAt: "2026-04-05T10:00:00.000Z",
          },
        ],
      }),
    ).toBe("/repo/folder-parent");
  });
  it("detects when a draft context override is present", () => {
    expect(hasDraftContextOverrides()).toBe(false);
    expect(hasDraftContextOverrides({ workingDirectory: "/repo/feature" })).toBe(true);
  });

  it("builds a draft patch only when overrides are provided", () => {
    expect(buildDraftThreadContextPatch("terminal")).toBeNull();
    expect(buildDraftThreadContextPatch("terminal", { workingDirectory: "/repo/feature" })).toEqual(
      {
        entryPoint: "terminal",
        workingDirectory: "/repo/feature",
      },
    );
  });

  it("recognizes when the active route draft can be reused", () => {
    expect(
      shouldReuseActiveDraftThread({
        draftThread: makeDraftThread(),
        entryPoint: "terminal",
        folderId: PROJECT_ID,
        routeThreadId: THREAD_ID,
      }),
    ).toBe(true);
    expect(
      shouldReuseActiveDraftThread({
        draftThread: makeDraftThread({ entryPoint: "chat" }),
        entryPoint: "terminal",
        folderId: PROJECT_ID,
        routeThreadId: THREAD_ID,
      }),
    ).toBe(false);
  });

  it("resolves bootstrap precedence as route draft, then stored draft, then fresh", () => {
    expect(
      resolveThreadBootstrapPlan({
        storedDraftThread: { threadId: ThreadId.makeUnsafe("stored-thread"), ...makeDraftThread() },
        latestActiveDraftThread: makeDraftThread({}),
        entryPoint: "terminal",
        folderId: PROJECT_ID,
        routeThreadId: THREAD_ID,
      }),
    ).toMatchObject({ kind: "route", threadId: THREAD_ID });
    expect(
      resolveThreadBootstrapPlan({
        storedDraftThread: { threadId: THREAD_ID, ...makeDraftThread() },
        latestActiveDraftThread: null,
        entryPoint: "terminal",
        folderId: PROJECT_ID,
        routeThreadId: null,
      }),
    ).toMatchObject({ kind: "stored", threadId: THREAD_ID });
    expect(
      resolveThreadBootstrapPlan({
        storedDraftThread: null,
        latestActiveDraftThread: null,
        entryPoint: "terminal",
        folderId: PROJECT_ID,
        routeThreadId: null,
      }),
    ).toEqual({ kind: "fresh" });
  });

  it("creates stable snapshots for active thread state", () => {
    expect(
      createActiveThreadSnapshot(
        {
          folderId: PROJECT_ID,
          modelSelection: modelSelection("codex", "gpt-5"),
          runtimeMode: "full-access",
        },
        PROJECT_ID,
      ),
    ).toEqual({
      folderId: PROJECT_ID,
      modelSelection: modelSelection("codex", "gpt-5"),
      runtimeMode: "full-access",
    });
    expect(createActiveDraftThreadSnapshot(makeDraftThread(), PROJECT_ID)).toEqual({
      ...makeDraftThread(),
      workingDirectory: null,
    });
  });

  it("lets an active draft override inherited branch and worktree context", () => {
    expect(
      resolveInheritedThreadContext({
        activeThread: {},
        activeDraftThread: makeDraftThread({}),
      }),
    ).toEqual({
      workingDirectory: null,
    });
  });

  it("lets a local active draft clear active thread branch and worktree context", () => {
    expect(
      resolveInheritedThreadContext({
        activeThread: {},
        activeDraftThread: makeDraftThread({}),
      }),
    ).toEqual({
      workingDirectory: null,
    });
  });

  it("derives inherited environment mode from the active thread when no draft exists", () => {
    expect(
      resolveInheritedThreadContext({
        activeThread: {},
        activeDraftThread: null,
      }),
    ).toEqual({
      workingDirectory: null,
    });
  });

  it("builds the fresh draft seed from creation inputs", () => {
    expect(
      createFreshDraftThreadSeed({
        createdAt: "2026-04-05T10:00:00.000Z",
        entryPoint: "terminal",
        options: {},
      }),
    ).toEqual({
      createdAt: "2026-04-05T10:00:00.000Z",
      spaceId: null,
      workingDirectory: null,
      runtimeMode: "full-access",
      entryPoint: "terminal",
    });
  });

  it("prefers draft state when resolving terminal creation payloads", () => {
    expect(
      resolveTerminalThreadCreationState({
        activeDraftThread: null,
        activeThread: {
          folderId: PROJECT_ID,
          modelSelection: modelSelection("codex", "gpt-5"),
          runtimeMode: "full-access",
        },
        draftComposerState: makeComposerDraftState(),
        draftThread: makeDraftThread(),
        options: undefined,
        projectDefaultModelSelection: modelSelection("codex", "gpt-5.4"),
        folderId: PROJECT_ID,
      }),
    ).toEqual({
      spaceId: null,
      modelSelection: modelSelection("claudeAgent", "claude-opus-4-6", {
        effort: "max",
      }),
      runtimeMode: "approval-required",
      workingDirectory: null,
    });
  });

  it("clears inherited worktree state when an explicit local env override is requested", () => {
    expect(
      resolveTerminalThreadCreationState({
        activeDraftThread: null,
        activeThread: {
          folderId: PROJECT_ID,
          modelSelection: modelSelection("codex", "gpt-5"),
          runtimeMode: "full-access",
        },
        draftComposerState: makeComposerDraftState(),
        draftThread: makeDraftThread(),
        options: {},
        projectDefaultModelSelection: modelSelection("codex", "gpt-5.4"),
        folderId: PROJECT_ID,
      }),
    ).toMatchObject({});
  });
});
