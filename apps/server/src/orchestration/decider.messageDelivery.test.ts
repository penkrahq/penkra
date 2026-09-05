import {
  CommandId,
  FolderId,
  MessageId,
  SpaceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@penkra/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-08-27T12:00:00.000Z";
const threadId = ThreadId.makeUnsafe("thread-shell-only-delivery");
const messageId = MessageId.makeUnsafe("queued-message-before-restart");

const shellOnlyReadModel: OrchestrationReadModel = {
  snapshotSequence: 10,
  updatedAt: NOW,
  spaces: [
    {
      id: SpaceId.makeUnsafe("space-shell-only-delivery"),
      name: "Personal",
      icon: "home",
      sortOrder: 0,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      deletedAt: null,
    },
  ],
  folders: [
    {
      id: FolderId.makeUnsafe("folder-shell-only-delivery"),
      spaceId: SpaceId.makeUnsafe("space-shell-only-delivery"),
      title: "Queue QA",
      workspaceRoot: null,
      defaultModelSelection: { provider: "codex", model: "gpt-5.4-mini" },
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    },
  ],
  threads: [
    {
      id: threadId,
      folderId: FolderId.makeUnsafe("folder-shell-only-delivery"),
      title: "Queue QA",
      modelSelection: { provider: "codex", model: "gpt-5.4-mini" },
      runtimeMode: "full-access",
      createdAt: NOW,
      updatedAt: NOW,
      latestTurn: null,
      messages: [],
      session: null,
      activities: [],
      deletedAt: null,
    },
  ],
};

describe("message delivery decisions", () => {
  it("appends a normal send behind an existing queue even when the projected session is idle", async () => {
    const queuedHeadId = MessageId.makeUnsafe("queued-head-before-idle-admission");
    const readModel: OrchestrationReadModel = {
      ...shellOnlyReadModel,
      threads: shellOnlyReadModel.threads.map((thread) => ({
        ...thread,
        parentThreadId: null,
        queuedMessageIds: [queuedHeadId],
      })),
    };

    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("send-behind-existing-queue"),
          threadId,
          message: {
            messageId: MessageId.makeUnsafe("message-behind-existing-queue"),
            role: "user",
            text: "Open up B1",
            attachments: [],
          },
          runtimeMode: "full-access",
          createdAt: NOW,
        },
      }),
    );

    const events = Array.isArray(decided) ? decided : [decided];
    expect(events.map((event) => event.type)).toEqual([
      "thread.message-sent",
      "thread.turn-queued",
    ]);
    expect(events[0]).toMatchObject({
      payload: { delivery: { state: "queued", queued: true } },
    });
  });

  it("accepts a durable acknowledgement after shell-only restart hydration", async () => {
    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: shellOnlyReadModel,
        command: {
          type: "thread.message.delivery.set",
          commandId: CommandId.makeUnsafe("delivery-after-shell-only-restart"),
          threadId,
          messageId,
          state: "accepted",
          createdAt: NOW,
        },
      }),
    );

    expect(decided).toMatchObject({
      type: "thread.message-delivery-set",
      payload: { threadId, messageId, state: "accepted", updatedAt: NOW },
    });
  });

  it("preserves a newer starting session when an older terminal write loses its guard", async () => {
    const newerUpdatedAt = "2026-08-27T12:00:01.000Z";
    const currentSession = {
      threadId,
      status: "starting" as const,
      providerName: "codex" as const,
      runtimeMode: "full-access" as const,
      activeTurnId: null,
      lastError: null,
      updatedAt: newerUpdatedAt,
    };
    const readModel: OrchestrationReadModel = {
      ...shellOnlyReadModel,
      threads: shellOnlyReadModel.threads.map((thread) => ({
        ...thread,
        session: currentSession,
      })),
    };

    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("stale-terminal-session-write"),
          threadId,
          expectedSessionStatus: "running",
          expectedSessionUpdatedAt: NOW,
          preserveCurrentSessionOnMismatch: true,
          session: {
            ...currentSession,
            status: "ready",
            updatedAt: "2026-08-27T12:00:02.000Z",
          },
          createdAt: "2026-08-27T12:00:02.000Z",
        },
      }),
    );

    expect(decided).toMatchObject({
      type: "thread.session-set",
      payload: { threadId, session: currentSession },
    });
  });
});
