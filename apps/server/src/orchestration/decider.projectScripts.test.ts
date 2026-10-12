import { seedThreadReadModelFixture } from "../cleanCore/threadFixtures.ts";
import { CommandId, EventId, MessageId, FolderId, SpaceId, ThreadId } from "@penkra/contracts";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import {
  CONNECTION_CHANGED_ACTIVITY_KIND,
  MODEL_CHANGED_ACTIVITY_KIND,
  decideOrchestrationCommand,
} from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asFolderId = (value: string): FolderId => FolderId.makeUnsafe(value);
const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);
const TEST_SPACE_ID = SpaceId.makeUnsafe("space-project-scripts");

async function withTestSpace(now: string) {
  return Effect.runPromise(
    projectEvent(createEmptyReadModel(now), {
      sequence: 1,
      eventId: asEventId("evt-space-project-scripts"),
      aggregateKind: "space",
      aggregateId: TEST_SPACE_ID,
      type: "space.created",
      occurredAt: now,
      commandId: CommandId.makeUnsafe("cmd-space-project-scripts"),
      causationEventId: null,
      correlationId: CommandId.makeUnsafe("cmd-space-project-scripts"),
      metadata: {},
      payload: {
        spaceId: TEST_SPACE_ID,
        name: "Personal",
        icon: "home",
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
      },
    }),
  );
}

describe("decider project scripts", () => {
  it("allows folders to share a directory", async () => {
    const now = new Date().toISOString();
    const initial = await withTestSpace(now);
    const withFirstProject = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-stale-project-a"),
        aggregateKind: "folder",
        aggregateId: asFolderId("project-stale-a"),
        type: "folder.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-stale-project-a"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-stale-project-a"),
        metadata: {},
        payload: {
          folderId: asFolderId("project-stale-a"),
          title: "Stale A",
          workspaceRoot: "/tmp/recreate-root",
          defaultModelSelection: null,
          spaceId: TEST_SPACE_ID,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const readModel = await Effect.runPromise(
      projectEvent(withFirstProject, {
        sequence: 2,
        eventId: asEventId("evt-stale-project-b"),
        aggregateKind: "folder",
        aggregateId: asFolderId("project-stale-b"),
        type: "folder.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-stale-project-b"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-stale-project-b"),
        metadata: {},
        payload: {
          folderId: asFolderId("project-stale-b"),
          title: "Stale B",
          workspaceRoot: "/tmp/recreate-root",
          defaultModelSelection: null,
          spaceId: TEST_SPACE_ID,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "folder.create",
            commandId: CommandId.makeUnsafe("cmd-project-recreate"),
            folderId: asFolderId("project-recreated"),
            title: "Recreated",
            workspaceRoot: "/tmp/recreate-root",
            spaceId: TEST_SPACE_ID,
            createdAt: now,
          },
          readModel,
        }),
      ),
    ).resolves.toMatchObject({
      type: "folder.created",
      payload: { workspaceRoot: "/tmp/recreate-root" },
    });
  });

  it("allows a folder directory already used by a folder with saved chats", async () => {
    const now = new Date().toISOString();
    const initial = await withTestSpace(now);
    const withStaleProject = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-mixed-stale-project"),
        aggregateKind: "folder",
        aggregateId: asFolderId("project-mixed-stale"),
        type: "folder.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-mixed-stale-project"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-mixed-stale-project"),
        metadata: {},
        payload: {
          folderId: asFolderId("project-mixed-stale"),
          title: "Mixed Stale",
          workspaceRoot: "/tmp/mixed-root",
          defaultModelSelection: null,
          spaceId: TEST_SPACE_ID,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const withActiveProject = await Effect.runPromise(
      projectEvent(withStaleProject, {
        sequence: 2,
        eventId: asEventId("evt-mixed-active-project"),
        aggregateKind: "folder",
        aggregateId: asFolderId("project-mixed-active"),
        type: "folder.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-mixed-active-project"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-mixed-active-project"),
        metadata: {},
        payload: {
          folderId: asFolderId("project-mixed-active"),
          title: "Mixed Active",
          workspaceRoot: "/tmp/mixed-root",
          defaultModelSelection: null,
          spaceId: TEST_SPACE_ID,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const readModel = await Effect.runPromise(
      seedThreadReadModelFixture(withActiveProject, {
        threadId: ThreadId.makeUnsafe(ThreadId.makeUnsafe("thread-mixed-active")),
        folderId: FolderId.makeUnsafe(asFolderId("project-mixed-active")),
        title: "Saved chat",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        runtimeMode: "approval-required",
        createdAt: now,
        connection: { kind: "selected", connectionId: null },
        creator: { kind: "user" },
        sidebarSortOrder: 0,
      }),
    );

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "folder.create",
            commandId: CommandId.makeUnsafe("cmd-project-mixed-recreate"),
            folderId: asFolderId("project-mixed-recreated"),
            title: "Mixed Recreated",
            workspaceRoot: "/tmp/mixed-root",
            spaceId: TEST_SPACE_ID,
            createdAt: now,
          },
          readModel,
        }),
      ),
    ).resolves.toMatchObject({
      type: "folder.created",
      payload: { workspaceRoot: "/tmp/mixed-root" },
    });
  });
  it("emits user message and turn-start-requested events for thread.turn.start", async () => {
    const now = new Date().toISOString();
    const initial = createEmptyReadModel(now);
    const withProject = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create"),
        aggregateKind: "folder",
        aggregateId: asFolderId("project-1"),
        type: "folder.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-project-create"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-project-create"),
        metadata: {},
        payload: {
          folderId: asFolderId("project-1"),
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: null,
          spaceId: TEST_SPACE_ID,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const readModel = await Effect.runPromise(
      seedThreadReadModelFixture(withProject, {
        threadId: ThreadId.makeUnsafe(ThreadId.makeUnsafe("thread-1")),
        folderId: FolderId.makeUnsafe(asFolderId("project-1")),
        title: "Thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        runtimeMode: "approval-required",
        createdAt: now,
        connection: { kind: "selected", connectionId: null },
        creator: { kind: "user" },
        sidebarSortOrder: 0,
      }),
    );

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-turn-start"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          message: {
            messageId: asMessageId("message-user-1"),
            role: "user",
            text: "hello",
            attachments: [],
          },
          modelSelection: {
            provider: "codex",
            model: "gpt-5.3-codex",
            options: {
              reasoningEffort: "high",
              fastMode: true,
            },
          },
          runtimeMode: "approval-required",
          createdAt: now,
        },
        readModel,
      }),
    );

    expect(Array.isArray(result)).toBe(true);
    const events = Array.isArray(result) ? result : [result];
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("thread.message-sent");
    const turnStartEvent = events[1];
    expect(turnStartEvent?.type).toBe("thread.turn-start-requested");
    expect(turnStartEvent?.causationEventId).toBe(events[0]?.eventId ?? null);
    if (turnStartEvent?.type !== "thread.turn-start-requested") {
      return;
    }
    expect(turnStartEvent.payload.assistantDeliveryMode).toBe("buffered");
    expect(turnStartEvent.payload).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      messageId: asMessageId("message-user-1"),
      modelSelection: {
        provider: "codex",
        model: "gpt-5.3-codex",
        options: {
          reasoningEffort: "high",
          fastMode: true,
        },
      },
      runtimeMode: "approval-required",
    });

    const switchedResult = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-turn-start-switched"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          message: {
            messageId: asMessageId("message-user-switched"),
            role: "user",
            text: "continue with work",
            attachments: [],
          },
          runtimeMode: "approval-required",
          createdAt: now,
        },
        readModel,
        acceptedConnectionChange: {
          previousConnectionId: "connection-personal",
          connectionId: "connection-work",
          label: "Work",
          previousModelId: "gpt-5-codex",
          modelId: "gpt-5.3-codex",
          modelLabel: "GPT-5.3 Codex",
        },
      }),
    );
    const switchedEvents = Array.isArray(switchedResult) ? switchedResult : [switchedResult];
    expect(switchedEvents).toHaveLength(4);
    expect(switchedEvents.map((event) => event.type)).toEqual([
      "thread.activity-appended",
      "thread.activity-appended",
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    const activityEvent = switchedEvents[0];
    expect(activityEvent?.type).toBe("thread.activity-appended");
    if (activityEvent?.type === "thread.activity-appended") {
      expect(activityEvent.payload.activity).toMatchObject({
        kind: CONNECTION_CHANGED_ACTIVITY_KIND,
        summary: "Connection changed to Work",
        payload: {
          previousConnectionId: "connection-personal",
          connectionId: "connection-work",
        },
      });
    }
    expect(switchedEvents[1]?.causationEventId).toBe(switchedEvents[0]?.eventId);
    expect(switchedEvents[2]?.causationEventId).toBe(switchedEvents[1]?.eventId);
    expect(switchedEvents[3]?.causationEventId).toBe(switchedEvents[2]?.eventId);
    const modelActivityEvent = switchedEvents[1];
    expect(modelActivityEvent?.type).toBe("thread.activity-appended");
    if (modelActivityEvent?.type === "thread.activity-appended") {
      expect(modelActivityEvent.payload.activity).toMatchObject({
        kind: MODEL_CHANGED_ACTIVITY_KIND,
        summary: "Model changed to GPT-5.3 Codex",
        payload: {
          previousModelId: "gpt-5-codex",
          modelId: "gpt-5.3-codex",
          modelLabel: "GPT-5.3 Codex",
        },
      });
    }

    const rebuiltResult = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-turn-start-rebuilt"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          message: {
            messageId: asMessageId("message-user-rebuilt"),
            role: "user",
            text: "continue from history",
            attachments: [],
          },
          runtimeMode: "approval-required",
          createdAt: now,
        },
        readModel,
        acceptedConnectionChange: {
          connectionId: "connection-work",
          label: "Work",
          previousModelId: "gpt-5-codex",
          modelId: "gpt-5-codex",
          modelLabel: "GPT-5 Codex",
          previousConnectionId: "connection-work",
        },
      }),
    );
    const rebuiltEvents = Array.isArray(rebuiltResult) ? rebuiltResult : [rebuiltResult];
    const notice = rebuiltEvents.find(
      (event) =>
        event.type === "thread.activity-appended" &&
        event.payload.activity.kind === "continuation-reconstructed",
    );
    expect(notice).toBeUndefined();

    const anonymousResult = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-turn-start-anonymous"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          message: {
            messageId: asMessageId("message-user-anonymous"),
            role: "user",
            text: "use a free model",
            attachments: [],
          },
          runtimeMode: "approval-required",
          createdAt: now,
        },
        readModel,
        acceptedConnectionChange: {
          previousConnectionId: "connection-personal",
          connectionId: null,
          label: "OpenCode",
          previousModelId: "opencode-go/kimi-k2.5",
          modelId: "opencode/nemotron-3-super-free",
          modelLabel: "Nemotron 3 Super Free",
        },
      }),
    );
    const anonymousEvents = Array.isArray(anonymousResult) ? anonymousResult : [anonymousResult];
    expect(anonymousEvents).toHaveLength(3);
    expect(anonymousEvents.map((event) => event.type)).toEqual([
      "thread.activity-appended",
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    const anonymousActivity = anonymousEvents[0];
    expect(anonymousActivity?.type).toBe("thread.activity-appended");
    if (anonymousActivity?.type === "thread.activity-appended") {
      expect(anonymousActivity.payload.activity.kind).toBe(MODEL_CHANGED_ACTIVITY_KIND);
      expect(anonymousActivity.payload.activity.summary).not.toContain("Connection changed");
    }
  });
});
