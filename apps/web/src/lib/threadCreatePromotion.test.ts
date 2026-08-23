import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CommandId,
  FolderId,
  SpaceId,
  ThreadId,
  type ClientOrchestrationCommand,
  type NativeApi,
} from "@penkra/contracts";

import { useComposerDraftStore } from "../composerDraftStore";
import { useStore } from "../store";
import { getThreadFromState } from "../threadDerivation";
import { isDuplicateThreadCreateError, promoteThreadCreate } from "./threadCreatePromotion";

const initialStoreState = useStore.getState();
const initialComposerDraftState = useComposerDraftStore.getState();

afterEach(() => {
  useStore.setState(initialStoreState, true);
  useComposerDraftStore.setState(initialComposerDraftState, true);
});

function makeApi(input: {
  dispatchCommand: ReturnType<typeof vi.fn>;
  getShellSnapshot?: ReturnType<typeof vi.fn>;
}): NativeApi {
  return {
    orchestration: {
      dispatchCommand: input.dispatchCommand,
      getShellSnapshot: input.getShellSnapshot ?? vi.fn(),
    },
  } as unknown as NativeApi;
}

function makeThreadCreateCommand(threadId = "thread-promote") {
  return {
    type: "thread.create",
    commandId: CommandId.makeUnsafe(`cmd-${threadId}`),
    threadId: ThreadId.makeUnsafe(threadId),
    folderId: FolderId.makeUnsafe("project-promote"),
    title: "Promoted thread",
    modelSelection: {
      provider: "codex",
      model: "gpt-5",
    },
    runtimeMode: "full-access",
    createdAt: "2026-05-06T20:00:00.000Z",
  } satisfies Extract<ClientOrchestrationCommand, { type: "thread.create" }>;
}

function makeShellSnapshot(threadId: ThreadId, snapshotSequence = 1) {
  const folderId = FolderId.makeUnsafe("project-promote");
  return {
    snapshotSequence,
    spaces: [],
    folders: [
      {
        id: folderId,
        spaceId: SpaceId.makeUnsafe("space-test"),
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
        parentThreadId: null,
        subagentAgentId: null,
        subagentNickname: null,
        subagentRole: null,
        forkSourceThreadId: null,
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

describe("threadCreatePromotion", () => {
  it("recognizes duplicate thread.create invariant errors", () => {
    expect(
      isDuplicateThreadCreateError(
        new Error(
          "Orchestration command invariant failed (thread.create): Thread 'thread-promote' already exists and cannot be created twice.",
        ),
        ThreadId.makeUnsafe("thread-promote"),
      ),
    ).toBe(true);
  });

  it("joins concurrent promotions for the same thread id", async () => {
    let resolveDispatch: (() => void) | null = null;
    const dispatchCommand = vi.fn(
      () =>
        new Promise<{ sequence: number }>((resolve) => {
          resolveDispatch = () => resolve({ sequence: 1 });
        }),
    );
    const getShellSnapshot = vi.fn(() =>
      Promise.resolve(makeShellSnapshot(ThreadId.makeUnsafe("thread-concurrent"))),
    );
    const api = makeApi({ dispatchCommand, getShellSnapshot });
    const command = makeThreadCreateCommand("thread-concurrent");
    useComposerDraftStore.getState().setProjectDraftThreadId(command.folderId, command.threadId);

    const first = promoteThreadCreate(command, api);
    const second = promoteThreadCreate(
      { ...command, commandId: CommandId.makeUnsafe("cmd-thread-concurrent-second") },
      api,
    );
    expect(resolveDispatch).not.toBeNull();
    (resolveDispatch as unknown as () => void)();

    await expect(first).resolves.toBe("created");
    await expect(second).resolves.toBe("exists");
    expect(dispatchCommand).toHaveBeenCalledTimes(1);
    expect(getShellSnapshot).toHaveBeenCalledTimes(1);
    expect(getThreadFromState(useStore.getState(), command.threadId)?.id).toBe(command.threadId);
  });

  it("installs the exact accepted thread before provider admission", async () => {
    const threadId = ThreadId.makeUnsafe("thread-created-installed");
    const folderId = FolderId.makeUnsafe("project-promote");
    useComposerDraftStore.getState().setProjectDraftThreadId(folderId, threadId);
    const dispatchCommand = vi.fn().mockResolvedValue({ sequence: 7 });
    const getShellSnapshot = vi.fn().mockResolvedValue(makeShellSnapshot(threadId, 7));
    const api = makeApi({ dispatchCommand, getShellSnapshot });

    await expect(promoteThreadCreate(makeThreadCreateCommand(threadId), api)).resolves.toBe(
      "created",
    );

    expect(getShellSnapshot).toHaveBeenCalledOnce();
    expect(getThreadFromState(useStore.getState(), threadId)?.id).toBe(threadId);
    expect(useComposerDraftStore.getState().getDraftThread(threadId)?.promotedTo).toBe(threadId);
  });

  it("accepts an exact created thread even when the global snapshot sequence lags", async () => {
    const threadId = ThreadId.makeUnsafe("thread-stale-snapshot");
    const folderId = FolderId.makeUnsafe("project-promote");
    useComposerDraftStore.getState().setProjectDraftThreadId(folderId, threadId);
    const api = makeApi({
      dispatchCommand: vi.fn().mockResolvedValue({ sequence: 8 }),
      getShellSnapshot: vi.fn().mockResolvedValue(makeShellSnapshot(threadId, 7)),
    });

    await expect(promoteThreadCreate(makeThreadCreateCommand(threadId), api)).resolves.toBe(
      "created",
    );
    expect(api.orchestration.getShellSnapshot).toHaveBeenCalledOnce();
    expect(getThreadFromState(useStore.getState(), threadId)?.id).toBe(threadId);
    expect(useComposerDraftStore.getState().getDraftThread(threadId)?.promotedTo).toBe(threadId);
  });

  it("recovers a create that committed before a transport failure was reported", async () => {
    const threadId = ThreadId.makeUnsafe("thread-ambiguous-create");
    const api = makeApi({
      dispatchCommand: vi.fn().mockRejectedValue(new Error("socket closed")),
      getShellSnapshot: vi.fn().mockResolvedValue(makeShellSnapshot(threadId, 9)),
    });

    await expect(promoteThreadCreate(makeThreadCreateCommand(threadId), api)).resolves.toBe(
      "exists",
    );
    expect(getThreadFromState(useStore.getState(), threadId)?.id).toBe(threadId);
  });

  it("marks the draft as promoted when the thread already exists locally", async () => {
    const threadId = ThreadId.makeUnsafe("thread-existing-local");
    const folderId = FolderId.makeUnsafe("project-promote");
    useComposerDraftStore.getState().setProjectDraftThreadId(folderId, threadId);
    useStore.getState().syncServerShellSnapshot({
      snapshotSequence: 1,
      spaces: [],
      folders: [
        {
          id: folderId,
          spaceId: SpaceId.makeUnsafe("space-test"),
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
            provider: "codex",
            model: "gpt-5",
          },
          runtimeMode: "full-access",
          parentThreadId: null,
          subagentAgentId: null,
          subagentNickname: null,
          subagentRole: null,
          forkSourceThreadId: null,
          latestTurn: null,
          createdAt: "2026-05-06T20:00:00.000Z",
          updatedAt: "2026-05-06T20:00:00.000Z",
          archivedAt: null,
          session: null,
        },
      ],
      updatedAt: "2026-05-06T20:00:00.000Z",
    });
    const api = makeApi({ dispatchCommand: vi.fn() });

    await expect(promoteThreadCreate(makeThreadCreateCommand(threadId), api)).resolves.toBe(
      "exists",
    );

    expect(useComposerDraftStore.getState().getDraftThread(threadId)?.promotedTo).toBe(threadId);
  });

  it("recreates a React-known local draft even when stale client state still has the deleted id", async () => {
    const threadId = ThreadId.makeUnsafe("thread-retry-after-rollback");
    const folderId = FolderId.makeUnsafe("project-promote");
    useComposerDraftStore.getState().setProjectDraftThreadId(folderId, threadId);
    useStore.getState().syncServerShellSnapshot(makeShellSnapshot(threadId));
    const dispatchCommand = vi.fn().mockResolvedValue({ sequence: 10 });
    const getShellSnapshot = vi.fn().mockResolvedValue(makeShellSnapshot(threadId, 10));
    const api = makeApi({ dispatchCommand, getShellSnapshot });

    await expect(
      promoteThreadCreate(makeThreadCreateCommand(threadId), api, { force: true }),
    ).resolves.toBe("created");

    expect(dispatchCommand).toHaveBeenCalledOnce();
    expect(getShellSnapshot).toHaveBeenCalledOnce();
  });

  it("recovers duplicate promotions by syncing the shell snapshot", async () => {
    const threadId = ThreadId.makeUnsafe("thread-duplicate-recovered");
    const folderId = FolderId.makeUnsafe("project-promote");
    const dispatchCommand = vi.fn(() =>
      Promise.reject(
        new Error(
          `Orchestration command invariant failed (thread.create): Thread '${threadId}' already exists and cannot be created twice.`,
        ),
      ),
    );
    const getShellSnapshot = vi.fn(() =>
      Promise.resolve({
        snapshotSequence: 1,
        spaces: [],
        folders: [
          {
            id: folderId,
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
              provider: "codex",
              model: "gpt-5",
            },
            runtimeMode: "full-access",
            parentThreadId: null,
            subagentAgentId: null,
            subagentNickname: null,
            subagentRole: null,
            forkSourceThreadId: null,
            latestTurn: null,
            createdAt: "2026-05-06T20:00:00.000Z",
            updatedAt: "2026-05-06T20:00:00.000Z",
            archivedAt: null,
            session: null,
          },
        ],
        updatedAt: "2026-05-06T20:00:00.000Z",
      }),
    );
    const api = makeApi({ dispatchCommand, getShellSnapshot });

    await expect(promoteThreadCreate(makeThreadCreateCommand(threadId), api)).resolves.toBe(
      "exists",
    );
    expect(getShellSnapshot).toHaveBeenCalledTimes(1);
    expect(getThreadFromState(useStore.getState(), threadId)?.id).toBe(threadId);
  });
});
