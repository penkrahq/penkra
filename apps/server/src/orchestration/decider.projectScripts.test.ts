import { CommandId, EventId, MessageId, ContainerId, SpaceId, ThreadId } from "@penkra/contracts";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import {
  CONNECTION_CHANGED_ACTIVITY_KIND,
  MODEL_CHANGED_ACTIVITY_KIND,
  decideOrchestrationCommand,
} from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asProjectId = (value: string): ContainerId => ContainerId.makeUnsafe(value);
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
  it("emits empty scripts on project.create", async () => {
    const now = new Date().toISOString();
    const readModel = await withTestSpace(now);

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-project-create-scripts"),
          projectId: asProjectId("project-scripts"),
          title: "Scripts",
          workspaceRoot: null,
          spaceId: TEST_SPACE_ID,
          createdAt: now,
        },
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event.type).toBe("project.created");
    expect((event.payload as { scripts: unknown[] }).scripts).toEqual([]);
  });

  it("rejects legacy path-bound folder creation", async () => {
    const now = new Date().toISOString();
    const initial = await withTestSpace(now);
    const withFirstProject = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-stale-project-a"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-stale-a"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-stale-project-a"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-stale-project-a"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-stale-a"),
          title: "Stale A",
          workspaceRoot: "/tmp/recreate-root",
          defaultModelSelection: null,
          scripts: [],
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
        aggregateKind: "project",
        aggregateId: asProjectId("project-stale-b"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-stale-project-b"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-stale-project-b"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-stale-b"),
          title: "Stale B",
          workspaceRoot: "/tmp/recreate-root",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "project.create",
            commandId: CommandId.makeUnsafe("cmd-project-recreate"),
            projectId: asProjectId("project-recreated"),
            title: "Recreated",
            workspaceRoot: "/tmp/recreate-root",
            createdAt: now,
          },
          readModel,
        }),
      ),
    ).rejects.toThrow("Folders are virtual containers");
  });

  it("blocks on the project with saved threads before retiring empty duplicate shells", async () => {
    const now = new Date().toISOString();
    const initial = await withTestSpace(now);
    const withStaleProject = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-mixed-stale-project"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-mixed-stale"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-mixed-stale-project"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-mixed-stale-project"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-mixed-stale"),
          title: "Mixed Stale",
          workspaceRoot: "/tmp/mixed-root",
          defaultModelSelection: null,
          scripts: [],
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
        aggregateKind: "project",
        aggregateId: asProjectId("project-mixed-active"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-mixed-active-project"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-mixed-active-project"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-mixed-active"),
          title: "Mixed Active",
          workspaceRoot: "/tmp/mixed-root",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const readModel = await Effect.runPromise(
      projectEvent(withActiveProject, {
        sequence: 3,
        eventId: asEventId("evt-mixed-active-thread"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-mixed-active"),
        type: "thread.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-mixed-active-thread"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-mixed-active-thread"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-mixed-active"),
          projectId: asProjectId("project-mixed-active"),
          title: "Saved chat",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "approval-required",
          createdAt: now,
          updatedAt: now,
        },
      }),
    );

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "project.create",
            commandId: CommandId.makeUnsafe("cmd-project-mixed-recreate"),
            projectId: asProjectId("project-mixed-recreated"),
            title: "Mixed Recreated",
            workspaceRoot: "/tmp/mixed-root",
            createdAt: now,
          },
          readModel,
        }),
      ),
    ).rejects.toThrow("Folders are virtual containers");
  });

  it("propagates scripts in project.meta.update payload", async () => {
    const now = new Date().toISOString();
    const initial = await withTestSpace(now);
    const readModel = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create-scripts"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-scripts"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-project-create-scripts"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-project-create-scripts"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-scripts"),
          title: "Scripts",
          workspaceRoot: "/tmp/scripts",
          defaultModelSelection: null,
          scripts: [],
          spaceId: TEST_SPACE_ID,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );

    const scripts = [
      {
        id: "lint",
        name: "Lint",
        command: "bun run lint",
        icon: "lint",
        runOnWorktreeCreate: false,
      },
    ] as const;

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "project.meta.update",
          commandId: CommandId.makeUnsafe("cmd-project-update-scripts"),
          projectId: asProjectId("project-scripts"),
          scripts: Array.from(scripts),
        },
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event.type).toBe("project.meta-updated");
    expect((event.payload as { scripts?: unknown[] }).scripts).toEqual(scripts);
  });

  it("rejects pinning more than three active projects", async () => {
    const now = new Date().toISOString();
    let readModel = await withTestSpace(now);

    for (const index of [1, 2, 3, 4]) {
      readModel = await Effect.runPromise(
        projectEvent(readModel, {
          sequence: index,
          eventId: asEventId(`evt-project-pin-${index}`),
          aggregateKind: "project",
          aggregateId: asProjectId(`project-pin-${index}`),
          type: "project.created",
          occurredAt: now,
          commandId: CommandId.makeUnsafe(`cmd-project-pin-${index}`),
          causationEventId: null,
          correlationId: CommandId.makeUnsafe(`cmd-project-pin-${index}`),
          metadata: {},
          payload: {
            projectId: asProjectId(`project-pin-${index}`),
            title: `Project Pin ${index}`,
            workspaceRoot: `/tmp/project-pin-${index}`,
            defaultModelSelection: null,
            scripts: [],
            spaceId: TEST_SPACE_ID,
            isPinned: index <= 3,
            createdAt: now,
            updatedAt: now,
          },
        }),
      );
    }

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "project.meta.update",
            commandId: CommandId.makeUnsafe("cmd-project-pin-fourth"),
            projectId: asProjectId("project-pin-4"),
            isPinned: true,
          },
          readModel,
        }),
      ),
    ).rejects.toThrow("Only 3 projects can be pinned at once.");

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "project.meta.update",
          commandId: CommandId.makeUnsafe("cmd-project-repin-existing"),
          projectId: asProjectId("project-pin-1"),
          isPinned: true,
        },
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event.type).toBe("project.meta-updated");
  });

  it("emits user message and turn-start-requested events for thread.turn.start", async () => {
    const now = new Date().toISOString();
    const initial = createEmptyReadModel(now);
    const withProject = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-1"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-project-create"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-project-create"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-1"),
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const readModel = await Effect.runPromise(
      projectEvent(withProject, {
        sequence: 2,
        eventId: asEventId("evt-thread-create"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-1"),
        type: "thread.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-thread-create"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-thread-create"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "approval-required",
          createdAt: now,
          updatedAt: now,
        },
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

  it("emits thread.runtime-mode-set from thread.runtime-mode.set", async () => {
    const now = new Date().toISOString();
    const initial = createEmptyReadModel(now);
    const withProject = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-1"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-project-create"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-project-create"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-1"),
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const readModel = await Effect.runPromise(
      projectEvent(withProject, {
        sequence: 2,
        eventId: asEventId("evt-thread-create"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-1"),
        type: "thread.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-thread-create"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-thread-create"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          createdAt: now,
          updatedAt: now,
        },
      }),
    );

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.runtime-mode.set",
          commandId: CommandId.makeUnsafe("cmd-runtime-mode-set"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          runtimeMode: "approval-required",
          createdAt: now,
        },
        readModel,
      }),
    );

    const singleResult = Array.isArray(result) ? null : result;
    if (singleResult === null) {
      throw new Error("Expected a single runtime-mode-set event.");
    }
    expect(singleResult).toMatchObject({
      type: "thread.runtime-mode-set",
      payload: {
        threadId: ThreadId.makeUnsafe("thread-1"),
        runtimeMode: "approval-required",
      },
    });
  });
});
