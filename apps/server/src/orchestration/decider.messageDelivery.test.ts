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
});
