import { describe, expect, it } from "vitest";
import {
  MessageId,
  CommandId,
  FolderId,
  SpaceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@penkra/contracts";
import { Effect } from "effect";

import {
  findThreadById,
  listThreadsByFolderId,
  requireNonNegativeInteger,
  requireFolderHasNoThreads,
  requireThread,
  requireThreadAbsent,
  requireThreadArchived,
  requireThreadNotArchived,
} from "./commandInvariants.ts";

const now = new Date().toISOString();
const spaceId = SpaceId.makeUnsafe("space-test");

const readModel: OrchestrationReadModel = {
  snapshotSequence: 2,
  updatedAt: now,
  spaces: [],
  folders: [
    {
      id: FolderId.makeUnsafe("project-a"),
      spaceId,
      title: "Project A",
      workspaceRoot: "/tmp/project-a",
      defaultModelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      scripts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
    {
      id: FolderId.makeUnsafe("project-b"),
      spaceId,
      title: "Project B",
      workspaceRoot: "/tmp/project-b",
      defaultModelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      scripts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
  ],
  threads: [
    {
      id: ThreadId.makeUnsafe("thread-1"),
      folderId: FolderId.makeUnsafe("project-a"),
      title: "Thread A",
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      runtimeMode: "full-access",
      createdAt: now,
      updatedAt: now,
      latestTurn: null,
      messages: [],
      session: null,
      activities: [],
      deletedAt: null,
    },
    {
      id: ThreadId.makeUnsafe("thread-2"),
      folderId: FolderId.makeUnsafe("project-b"),
      title: "Thread B",
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      runtimeMode: "full-access",
      createdAt: now,
      updatedAt: now,
      latestTurn: null,
      messages: [],
      session: null,
      activities: [],
      deletedAt: null,
    },
    {
      id: ThreadId.makeUnsafe("thread-archived"),
      folderId: FolderId.makeUnsafe("project-a"),
      title: "Archived Thread",
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      runtimeMode: "full-access",
      createdAt: now,
      updatedAt: now,
      archivedAt: now,
      latestTurn: null,
      messages: [],
      session: null,
      activities: [],
      deletedAt: null,
    },
    {
      id: ThreadId.makeUnsafe("thread-deleted"),
      folderId: FolderId.makeUnsafe("project-a"),
      title: "Deleted Thread",
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      runtimeMode: "full-access",
      createdAt: now,
      updatedAt: now,
      latestTurn: null,
      messages: [],
      session: null,
      activities: [],
      deletedAt: now,
    },
  ],
};

const messageSendCommand: OrchestrationCommand = {
  type: "thread.turn.start",
  commandId: CommandId.makeUnsafe("cmd-1"),
  threadId: ThreadId.makeUnsafe("thread-1"),
  message: {
    messageId: MessageId.makeUnsafe("msg-1"),
    role: "user",
    text: "hello",
    attachments: [],
  },
  runtimeMode: "approval-required",
  createdAt: now,
};

describe("commandInvariants", () => {
  it("finds threads by id and project", () => {
    expect(findThreadById(readModel, ThreadId.makeUnsafe("thread-1"))?.folderId).toBe("project-a");
    expect(findThreadById(readModel, ThreadId.makeUnsafe("missing"))).toBeUndefined();
    expect(
      listThreadsByFolderId(readModel, FolderId.makeUnsafe("project-b")).map((thread) => thread.id),
    ).toEqual([ThreadId.makeUnsafe("thread-2")]);
  });

  it("requires existing thread", async () => {
    const thread = await Effect.runPromise(
      requireThread({
        readModel,
        command: messageSendCommand,
        threadId: ThreadId.makeUnsafe("thread-1"),
      }),
    );
    expect(thread.id).toBe(ThreadId.makeUnsafe("thread-1"));

    await expect(
      Effect.runPromise(
        requireThread({
          readModel,
          command: messageSendCommand,
          threadId: ThreadId.makeUnsafe("missing"),
        }),
      ),
    ).rejects.toThrow("does not exist");

    await expect(
      Effect.runPromise(
        requireThread({
          readModel,
          command: messageSendCommand,
          threadId: ThreadId.makeUnsafe("thread-deleted"),
        }),
      ),
    ).rejects.toThrow("was deleted");
  });

  it("requires missing thread for create flows", async () => {
    await Effect.runPromise(
      requireThreadAbsent({
        readModel,
        command: {
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-2"),
          threadId: ThreadId.makeUnsafe("thread-3"),
          folderId: FolderId.makeUnsafe("project-a"),
          title: "new",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          createdAt: now,
        },
        threadId: ThreadId.makeUnsafe("thread-3"),
      }),
    );

    await expect(
      Effect.runPromise(
        requireThreadAbsent({
          readModel,
          command: {
            type: "thread.create",
            commandId: CommandId.makeUnsafe("cmd-3"),
            threadId: ThreadId.makeUnsafe("thread-1"),
            folderId: FolderId.makeUnsafe("project-a"),
            title: "dup",
            modelSelection: {
              provider: "codex",
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            createdAt: now,
          },
          threadId: ThreadId.makeUnsafe("thread-1"),
        }),
      ),
    ).rejects.toThrow("already exists");
  });

  it("requires non-negative integers", async () => {
    await Effect.runPromise(
      requireNonNegativeInteger({
        commandType: "thread.conversation.rollback.complete",
        field: "numTurns",
        value: 0,
      }),
    );

    await expect(
      Effect.runPromise(
        requireNonNegativeInteger({
          commandType: "thread.conversation.rollback.complete",
          field: "numTurns",
          value: -1,
        }),
      ),
    ).rejects.toThrow("greater than or equal to 0");
  });

  it("requires thread to be archived for unarchive command", async () => {
    const archiveCommand: OrchestrationCommand = {
      type: "thread.unarchive",
      commandId: CommandId.makeUnsafe("cmd-unarchive"),
      threadId: ThreadId.makeUnsafe("thread-archived"),
    };

    // Should succeed for archived thread
    const thread = await Effect.runPromise(
      requireThreadArchived({
        readModel,
        command: archiveCommand,
        threadId: ThreadId.makeUnsafe("thread-archived"),
      }),
    );
    expect(thread.id).toBe(ThreadId.makeUnsafe("thread-archived"));

    // Should fail for non-archived thread
    await expect(
      Effect.runPromise(
        requireThreadArchived({
          readModel,
          command: archiveCommand,
          threadId: ThreadId.makeUnsafe("thread-1"),
        }),
      ),
    ).rejects.toThrow("is not archived");
  });

  it("requires thread to not be archived for archive command", async () => {
    const archiveCommand: OrchestrationCommand = {
      type: "thread.archive",
      commandId: CommandId.makeUnsafe("cmd-archive"),
      threadId: ThreadId.makeUnsafe("thread-1"),
    };

    // Should succeed for non-archived thread
    const thread = await Effect.runPromise(
      requireThreadNotArchived({
        readModel,
        command: archiveCommand,
        threadId: ThreadId.makeUnsafe("thread-1"),
      }),
    );
    expect(thread.id).toBe(ThreadId.makeUnsafe("thread-1"));

    // Should fail for already archived thread
    await expect(
      Effect.runPromise(
        requireThreadNotArchived({
          readModel,
          command: archiveCommand,
          threadId: ThreadId.makeUnsafe("thread-archived"),
        }),
      ),
    ).rejects.toThrow("is already archived");
  });

  it("requires project to have no remaining threads before delete", async () => {
    const deleteCommand: OrchestrationCommand = {
      type: "folder.delete",
      commandId: CommandId.makeUnsafe("cmd-project-delete"),
      folderId: FolderId.makeUnsafe("project-a"),
    };

    await expect(
      Effect.runPromise(
        requireFolderHasNoThreads({
          readModel,
          command: deleteCommand,
          folderId: FolderId.makeUnsafe("project-a"),
        }),
      ),
    ).rejects.toThrow("still has 2 threads");

    await expect(
      Effect.runPromise(
        requireFolderHasNoThreads({
          readModel,
          command: deleteCommand,
          folderId: FolderId.makeUnsafe("project-missing"),
        }),
      ),
    ).resolves.toBeUndefined();
  });
});
