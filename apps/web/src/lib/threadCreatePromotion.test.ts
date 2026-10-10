import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FolderId,
  SpaceId,
  ThreadId,
  singletonThreadDeckId,
  type CleanCoreCreateThreadInput,
  type NativeApi,
} from "@penkra/contracts";
import { useComposerDraftStore } from "../composerDraftStore";
import { useStore } from "../store";
import { getThreadFromState } from "../threadDerivation";
import { promoteThreadCreate } from "./threadCreatePromotion";
const initialStoreState = useStore.getState();
const initialDraftState = useComposerDraftStore.getState();
afterEach(() => {
  useStore.setState(initialStoreState, true);
  useComposerDraftStore.setState(initialDraftState, true);
});
function input(): CleanCoreCreateThreadInput {
  const threadId = ThreadId.makeUnsafe("thread-promote");
  return {
    threadId,
    deckId: singletonThreadDeckId(threadId),
    folderId: FolderId.makeUnsafe("project-promote"),
    title: "Promoted thread",
    modelSelection: { provider: "codex", model: "gpt-5" },
    runtimeMode: "full-access",
    workingDirectory: null,
    connection: { kind: "selected", connectionId: null },
    creator: { kind: "user" },
    createdAt: "2026-05-06T20:00:00.000Z",
  };
}
function makeShellSnapshot(threadId: ThreadId, snapshotSequence = 1) {
  const folderId = FolderId.makeUnsafe("project-promote");
  const spaceId = SpaceId.makeUnsafe("space-test");
  const deckId = singletonThreadDeckId(threadId);
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
    decks: [
      {
        id: deckId,
        spaceId,
        threadIds: [threadId],
        createdAt: "2026-05-06T20:00:00.000Z",
        updatedAt: "2026-05-06T20:00:00.000Z",
      },
    ],
    threads: [
      {
        id: threadId,
        deckId,
        deckSortOrder: 0,
        folderId,
        title: "Promoted thread",
        modelSelection: {
          provider: "codex" as const,
          model: "gpt-5",
        },
        runtimeMode: "full-access" as const,
        parentThreadId: null,
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
  it("creates through the clean-core API and installs the stored shell before admission", async () => {
    const request = input();
    const createThread = vi.fn().mockResolvedValue({
      thread: { id: request.threadId },
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
    expect(getThreadFromState(useStore.getState(), request.threadId)?.title).toBe(
      "Promoted thread",
    );
  });
  it("uses the server's idempotent result on a repeated creation", async () => {
    const request = input();
    const createThread = vi.fn().mockResolvedValue({
      thread: { id: request.threadId },
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
    const failure = new Error("Connection closed");
    const getThreadShell = vi.fn();
    const api = {
      cleanCore: { createThread: vi.fn().mockRejectedValue(failure), getThreadShell },
    } as unknown as NativeApi;
    await expect(promoteThreadCreate(input(), api)).rejects.toBe(failure);
    expect(getThreadShell).not.toHaveBeenCalled();
  });
  it("preserves opened detail when an already-created draft is promoted again", async () => {
    const request = input();
    useComposerDraftStore.getState().setProjectDraftThreadId(request.folderId, request.threadId);
    useStore.getState().syncServerShellSnapshot(makeShellSnapshot(request.threadId));
    useStore.setState((state) => ({
      ...state,
      threadDetailSyncById: { ...state.threadDetailSyncById, [request.threadId]: "synced" },
    }));
    const api = {
      cleanCore: {
        createThread: vi.fn().mockResolvedValue({
          thread: { id: request.threadId },
          shell: makeShellSnapshot(request.threadId).threads[0],
          created: false,
        }),
        getThreadShell: vi.fn().mockResolvedValue(makeShellSnapshot(request.threadId).threads[0]),
      },
    } as unknown as NativeApi;
    expect(await promoteThreadCreate(request, api)).toBe("exists");
    expect(useStore.getState().threadDetailSyncById?.[request.threadId]).toBe("synced");
    expect(useComposerDraftStore.getState().getDraftThread(request.threadId)?.promotedTo).toBe(
      request.threadId,
    );
  });
  it("accepts concurrent idempotent server results without losing draft promotion", async () => {
    const request = input();
    useComposerDraftStore.getState().setProjectDraftThreadId(request.folderId, request.threadId);
    const shell = makeShellSnapshot(request.threadId).threads[0];
    const createThread = vi
      .fn()
      .mockResolvedValueOnce({
        thread: { id: request.threadId },
        shell: makeShellSnapshot(request.threadId).threads[0],
        created: true,
      })
      .mockResolvedValueOnce({
        thread: { id: request.threadId },
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
    expect(useComposerDraftStore.getState().getDraftThread(request.threadId)?.promotedTo).toBe(
      request.threadId,
    );
  });
});
