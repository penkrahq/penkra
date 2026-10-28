import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FolderId,
  SpaceId,
  ThreadId,
  type CleanCoreCreateThreadInput,
  type CleanCoreThreadSummary,
  type NativeApi,
} from "@penkra/contracts";
import { confirmServerThreads, useComposerDraftStore } from "../composerDraftStore";
import { useStore } from "../store";
import { getThreadFromState } from "../threadDerivation";
import { getThreadListById, resetThreadListForTests } from "../threadListStore";
import { promoteThreadCreate, applyThreadCreationResponse } from "./threadCreatePromotion";
const initialStoreState = useStore.getState();
const initialDraftState = useComposerDraftStore.getState();
afterEach(() => {
  resetThreadListForTests();
  useStore.setState(initialStoreState, true);
  useComposerDraftStore.setState(initialDraftState, true);
});
function input(): CleanCoreCreateThreadInput {
  const threadId = ThreadId.make("thread-promote");
  return {
    threadId,
    folderId: FolderId.make("project-promote"),
    title: "Promoted thread",
    modelSelection: { provider: "codex", model: "gpt-5" },
    runtimeMode: "full-access",
    connection: { kind: "selected", connectionId: null },
    creator: { kind: "user" },
    createdAt: "2026-05-06T20:00:00.000Z",
  };
}
function makeCanonicalThread(request: CleanCoreCreateThreadInput): CleanCoreThreadSummary {
  return {
    latestTurn: null,
    id: request.threadId,
    spaceId: SpaceId.make("space-test"),
    folderId: request.folderId,
    title: request.title,
    provider: request.modelSelection.provider,
    model: request.modelSelection.model,
    modelOptions: null,
    connectionId: null,
    runtimeMode: request.runtimeMode,
    state: "idle",
    activeTurnId: null,
    lastError: null,
    queue: "[]",
    saved: "[]",
    createdBy: "user",
    createdByThreadId: null,
    sidebarSortOrder: null,
    lastActivityAt: null,
    lastMessagePreview: null,
    lastUserMessageAt: null,
    lastVisitedAt: null,
    openQuestionCount: 0,
    latestOpenQuestion: null,
    archivedAt: null,
    deletedAt: null,
    createdAt: request.createdAt,
    updatedAt: request.createdAt,
  };
}
function makeShellSnapshot(threadId: ThreadId, snapshotSequence = 1) {
  const folderId = FolderId.make("project-promote");
  const spaceId = SpaceId.make("space-test");
  return {
    snapshotSequence,
    spaces: [],
    folders: [
      {
        id: folderId,
        spaceId,
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-05-06T20:00:00.000Z",
        updatedAt: "2026-05-06T20:00:00.000Z",
      },
    ],
    threads: [
      {
        id: threadId,

        folderId,
        title: "Promoted thread",
        modelSelection: {
          provider: "codex" as const,
          model: "gpt-5",
        },
        runtimeMode: "full-access" as const,
        subagentAgentId: null,
        subagentNickname: null,
        subagentRole: null,
        latestTurn: null,
        createdAt: "2026-05-06T20:00:00.000Z",
        updatedAt: "2026-05-06T20:00:00.000Z",
        archivedAt: null,
        session: null,
      },
    ],
    updatedAt: "2026-05-06T20:00:00.000Z",
  };
}

describe("clean-core draft promotion", () => {
  it.each(["event-first", "response-first"])(
    "keeps composer and unrelated drafts when confirmation is %s and duplicated",
    (order) => {
      const request = input();
      const otherFolder = FolderId.make("other-folder");
      const otherThread = ThreadId.make("other-thread");
      const store = useComposerDraftStore.getState();
      store.setProjectDraftThreadId(request.folderId, request.threadId);
      store.setPrompt(request.threadId, "follow-up in progress");
      store.setProjectDraftThreadId(otherFolder, otherThread);
      store.setPrompt(otherThread, "other draft");
      const event = () => confirmServerThreads(new Set([request.threadId]));
      const response = () =>
        applyThreadCreationResponse({
          thread: makeCanonicalThread(request),
          shell: makeShellSnapshot(request.threadId).threads[0]!,
          created: false,
        });
      if (order === "event-first") {
        event();
        response();
      } else {
        response();
        event();
      }
      event();
      const current = useComposerDraftStore.getState();
      expect(current.getDraftThread(request.threadId)).toBeNull();
      expect(current.draftsByThreadId[request.threadId]?.prompt).toBe("follow-up in progress");
      expect(current.getDraftThreadByFolderId(otherFolder)?.threadId).toBe(otherThread);
      expect(current.draftsByThreadId[otherThread]?.prompt).toBe("other draft");
    },
  );
  it("installs a first-send response without marking its transcript empty", () => {
    const request = input();
    useComposerDraftStore.getState().setProjectDraftThreadId(request.folderId, request.threadId);
    applyThreadCreationResponse({
      thread: makeCanonicalThread(request),
      shell: makeShellSnapshot(request.threadId).threads[0]!,
      created: true,
    });
    expect(getThreadListById().get(request.threadId)).toEqual(makeCanonicalThread(request));
    expect(getThreadFromState(useStore.getState(), request.threadId)?.id).toBe(request.threadId);
    expect(useStore.getState().threadDetailSyncById?.[request.threadId]).toBeUndefined();
    expect(useComposerDraftStore.getState().getDraftThread(request.threadId)).toBeNull();
  });
  it("creates through the clean-core API and installs the stored shell before admission", async () => {
    const request = input();
    const createThread = vi.fn().mockResolvedValue({
      thread: makeCanonicalThread(request),
      shell: makeShellSnapshot(request.threadId).threads[0],
      created: true,
    });
    const getThreadShell = vi
      .fn()
      .mockResolvedValue(makeShellSnapshot(request.threadId).threads[0]);
    const api = {
      cleanCore: { createThread, getThreadShell },
    } as unknown as NativeApi;
    expect(await promoteThreadCreate(request, api)).toBe("created");
    expect(createThread).toHaveBeenCalledWith(request);
    expect(getThreadShell).not.toHaveBeenCalled();
    expect(getThreadListById().get(request.threadId)).toEqual(makeCanonicalThread(request));
    expect(getThreadFromState(useStore.getState(), request.threadId)?.title).toBe(
      "Promoted thread",
    );
  });
  it("uses the server's idempotent result on a repeated creation", async () => {
    const request = input();
    const createThread = vi.fn().mockResolvedValue({
      thread: makeCanonicalThread(request),
      shell: makeShellSnapshot(request.threadId).threads[0],
      created: false,
    });
    const api = {
      cleanCore: {
        createThread,
        getThreadShell: vi.fn().mockResolvedValue(makeShellSnapshot(request.threadId).threads[0]),
      },
    } as unknown as NativeApi;
    expect(await promoteThreadCreate(request, api)).toBe("exists");
    expect(createThread).toHaveBeenCalledTimes(1);
  });
  it("propagates a failed creation without receipt or snapshot recovery", async () => {
    const request = input();
    useComposerDraftStore.getState().setProjectDraftThreadId(request.folderId, request.threadId);
    const failure = new Error("Connection closed");
    const getThreadShell = vi.fn();
    const api = {
      cleanCore: { createThread: vi.fn().mockRejectedValue(failure), getThreadShell },
    } as unknown as NativeApi;
    await expect(promoteThreadCreate(request, api)).rejects.toBe(failure);
    expect(getThreadShell).not.toHaveBeenCalled();
    expect(useComposerDraftStore.getState().getDraftThread(request.threadId)).not.toBeNull();
  });
  it("preserves opened detail when an already-created draft is promoted again", async () => {
    const request = input();
    useComposerDraftStore.getState().setProjectDraftThreadId(request.folderId, request.threadId);
    useStore
      .getState()
      .syncServerThreadShell(request.threadId, makeShellSnapshot(request.threadId).threads[0]!);
    useStore.setState((state) => ({
      ...state,
      threadDetailSyncById: { ...state.threadDetailSyncById, [request.threadId]: "synced" },
    }));
    const api = {
      cleanCore: {
        createThread: vi.fn().mockResolvedValue({
          thread: makeCanonicalThread(request),
          shell: makeShellSnapshot(request.threadId).threads[0],
          created: false,
        }),
        getThreadShell: vi.fn().mockResolvedValue(makeShellSnapshot(request.threadId).threads[0]),
      },
    } as unknown as NativeApi;
    expect(await promoteThreadCreate(request, api)).toBe("exists");
    expect(useStore.getState().threadDetailSyncById?.[request.threadId]).toBe("synced");
    expect(useComposerDraftStore.getState().getDraftThread(request.threadId)).toBeNull();
  });
  it("accepts concurrent idempotent server results without losing draft promotion", async () => {
    const request = input();
    useComposerDraftStore.getState().setProjectDraftThreadId(request.folderId, request.threadId);
    const shell = makeShellSnapshot(request.threadId).threads[0];
    const createThread = vi
      .fn()
      .mockResolvedValueOnce({
        thread: makeCanonicalThread(request),
        shell: makeShellSnapshot(request.threadId).threads[0],
        created: true,
      })
      .mockResolvedValueOnce({
        thread: makeCanonicalThread(request),
        shell: makeShellSnapshot(request.threadId).threads[0],
        created: false,
      });
    const api = {
      cleanCore: { createThread, getThreadShell: vi.fn().mockResolvedValue(shell) },
    } as unknown as NativeApi;
    expect(
      await Promise.all([promoteThreadCreate(request, api), promoteThreadCreate(request, api)]),
    ).toEqual(["created", "exists"]);
    expect(getThreadFromState(useStore.getState(), request.threadId)?.id).toBe(request.threadId);
    expect(useComposerDraftStore.getState().getDraftThread(request.threadId)).toBeNull();
  });
});
