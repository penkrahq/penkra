import { FolderId, type ModelSelection, SpaceId, ThreadId } from "@penkra/contracts";
import { describe, expect, it } from "vitest";
import { type DraftThreadState } from "../composerDraftStore";
import {
  buildDraftThreadContextPatch,
  createActiveDraftThreadSnapshot,
  createActiveThreadSnapshot,
  createFreshDraftThreadSeed,
  hasDraftContextOverrides,
  requireNewThreadSpaceId,
  scopeNewThreadOptionsToContainer,
  scopeNewThreadOptionsToParentSpace,
  resolveThreadBootstrapPlan,
  shouldReuseActiveDraftThread,
} from "./threadBootstrap";

const PROJECT_ID = FolderId.make("project-bootstrap");
const THREAD_ID = ThreadId.make("thread-bootstrap");

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
    ...partial,
  };
}

describe("threadBootstrap", () => {
  it("requires the selected top-parent Space when persisting a new Thread", () => {
    const personalId = SpaceId.make("personal");
    expect(requireNewThreadSpaceId(personalId)).toBe(personalId);
    expect(() => requireNewThreadSpaceId(null)).toThrow(
      "Choose a persisted Space before starting this chat.",
    );
  });

  it("uses the virtual Folder's owning Space for a new Thread", () => {
    const personalId = SpaceId.make("personal");
    expect(
      scopeNewThreadOptionsToParentSpace({ spaceId: SpaceId.make("stale-space") }, personalId),
    ).toEqual({ spaceId: personalId });
  });

  it("uses the Folder's owning Space through container scoping", () => {
    const personalId = SpaceId.make("personal");
    const workId = SpaceId.make("work");
    expect(
      scopeNewThreadOptionsToContainer({
        options: { spaceId: workId },
        containerSpaceId: personalId,
      }),
    ).toEqual({ spaceId: personalId });
  });

  it("detects when a draft context override is present", () => {
    expect(hasDraftContextOverrides()).toBe(false);
    expect(hasDraftContextOverrides({ spaceId: SpaceId.make("bootstrap-space") })).toBe(true);
  });

  it("builds a draft patch only when overrides are provided", () => {
    expect(buildDraftThreadContextPatch()).toBeNull();
    expect(buildDraftThreadContextPatch({ spaceId: SpaceId.make("bootstrap-space") })).toEqual({
      spaceId: SpaceId.make("bootstrap-space"),
    });
  });

  it("recognizes when the active route draft can be reused", () => {
    expect(
      shouldReuseActiveDraftThread({
        draftThread: makeDraftThread(),
        folderId: PROJECT_ID,
        routeThreadId: THREAD_ID,
      }),
    ).toBe(true);
    expect(
      shouldReuseActiveDraftThread({
        draftThread: makeDraftThread({ folderId: FolderId.make("other-folder") }),
        folderId: PROJECT_ID,
        routeThreadId: THREAD_ID,
      }),
    ).toBe(false);
    expect(
      shouldReuseActiveDraftThread({
        draftThread: makeDraftThread({ promotedTo: THREAD_ID }),
        folderId: PROJECT_ID,
        routeThreadId: THREAD_ID,
      }),
    ).toBe(false);
  });

  it("resolves bootstrap precedence as route draft, then stored draft, then fresh", () => {
    expect(
      resolveThreadBootstrapPlan({
        storedDraftThread: { threadId: ThreadId.make("stored-thread"), ...makeDraftThread() },
        latestActiveDraftThread: makeDraftThread({}),
        folderId: PROJECT_ID,
        routeThreadId: THREAD_ID,
      }),
    ).toMatchObject({ kind: "route", threadId: THREAD_ID });
    expect(
      resolveThreadBootstrapPlan({
        storedDraftThread: { threadId: THREAD_ID, ...makeDraftThread() },
        latestActiveDraftThread: null,
        folderId: PROJECT_ID,
        routeThreadId: null,
      }),
    ).toMatchObject({ kind: "stored", threadId: THREAD_ID });
    expect(
      resolveThreadBootstrapPlan({
        storedDraftThread: null,
        latestActiveDraftThread: null,
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
    });
  });

  it("builds the fresh draft seed from creation inputs", () => {
    expect(
      createFreshDraftThreadSeed({
        createdAt: "2026-04-05T10:00:00.000Z",
        options: {},
      }),
    ).toEqual({
      createdAt: "2026-04-05T10:00:00.000Z",
      spaceId: null,
      runtimeMode: "full-access",
    });
  });
});
