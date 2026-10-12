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

import { findThreadById, requireNonNegativeInteger, requireThread } from "./commandInvariants.ts";

const now = new Date().toISOString();

const readModel: OrchestrationReadModel = {
  snapshotSequence: 2,
  updatedAt: now,
  threads: [
    {
      id: ThreadId.makeUnsafe("thread-1"),
      folderId: FolderId.makeUnsafe("project-a"),
      title: "Thread A",
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
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
  it("finds threads by id", () => {
    expect(findThreadById(readModel, ThreadId.makeUnsafe("thread-1"))?.folderId).toBe("project-a");
    expect(findThreadById(readModel, ThreadId.makeUnsafe("missing"))).toBeUndefined();
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
});
