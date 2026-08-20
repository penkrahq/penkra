import {
  CommandId,
  EventId,
  ContainerId,
  SpaceId,
  ThreadId,
  type OrchestrationEvent,
} from "@penkra/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { createEmptyReadModel, projectEvent } from "./projector.ts";

function makeEvent(input: {
  sequence: number;
  type: OrchestrationEvent["type"];
  occurredAt: string;
  aggregateKind: OrchestrationEvent["aggregateKind"];
  aggregateId: string;
  commandId: string | null;
  payload: unknown;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.makeUnsafe(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: input.aggregateKind,
    aggregateId:
      input.aggregateKind === "space"
        ? SpaceId.makeUnsafe(input.aggregateId)
        : input.aggregateKind === "project"
          ? ContainerId.makeUnsafe(input.aggregateId)
          : ThreadId.makeUnsafe(input.aggregateId),
    occurredAt: input.occurredAt,
    commandId: input.commandId === null ? null : CommandId.makeUnsafe(input.commandId),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

function makeSessionSetEvent(input: {
  sequence: number;
  commandId: string;
  occurredAt: string;
  status: string;
  activeTurnId: string | null;
  lastError: string | null;
  updatedAt: string;
}): OrchestrationEvent {
  return makeEvent({
    sequence: input.sequence,
    type: "thread.session-set",
    aggregateKind: "thread",
    aggregateId: "thread-1",
    occurredAt: input.occurredAt,
    commandId: input.commandId,
    payload: {
      threadId: "thread-1",
      session: {
        threadId: "thread-1",
        status: input.status,
        providerName: "codex",
        providerSessionId: "session-1",
        providerThreadId: "provider-thread-1",
        runtimeMode: "full-access",
        activeTurnId: input.activeTurnId,
        lastError: input.lastError,
        updatedAt: input.updatedAt,
      },
    },
  });
}

// Projects "thread-1" through creation and a running session on "turn-1".
async function projectThreadWithRunningTurn(input: { createdAt: string; startedAt: string }) {
  const afterCreate = await Effect.runPromise(
    projectEvent(
      createEmptyReadModel(input.createdAt),
      makeEvent({
        sequence: 1,
        type: "thread.created",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: input.createdAt,
        commandId: "cmd-create",
        payload: {
          threadId: "thread-1",
          projectId: "project-1",
          title: "demo",
          modelSelection: {
            provider: "codex",
            model: "gpt-5.3-codex",
          },
          runtimeMode: "full-access",
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        },
      }),
    ),
  );

  return Effect.runPromise(
    projectEvent(
      afterCreate,
      makeSessionSetEvent({
        sequence: 2,
        commandId: "cmd-running",
        occurredAt: input.startedAt,
        status: "running",
        activeTurnId: "turn-1",
        lastError: null,
        updatedAt: input.startedAt,
      }),
    ),
  );
}

describe("orchestration projector", () => {
  it("applies thread.created events", async () => {
    const now = new Date().toISOString();
    const model = createEmptyReadModel(now);

    const next = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: now,
          commandId: "cmd-thread-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: "codex",
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            createdAt: now,
            updatedAt: now,
          },
        }),
      ),
    );

    expect(next.snapshotSequence).toBe(1);
    expect(next.threads).toEqual([
      {
        id: "thread-1",
        projectId: "project-1",
        spaceId: null,
        sidebarSortOrder: 0,
        title: "demo",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        runtimeMode: "full-access",
        workingDirectory: null,
        isPinned: false,
        parentThreadId: null,
        creationSource: null,
        sourceThreadId: null,
        sourceTurnId: null,
        gatewayOperationId: null,
        gatewayOperationIndex: null,
        subagentAgentId: null,
        subagentNickname: null,
        subagentRole: null,
        forkSourceThreadId: null,
        latestTurn: null,
        pendingTurnStartMessageId: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        deletedAt: null,
        messages: [],
        queuedMessageIds: [],
        activities: [],
        session: null,
      },
    ]);
  });

  it("updates thread settings from turn start events", async () => {
    const createdAt = "2026-02-23T08:00:00.000Z";
    const turnRequestedAt = "2026-02-23T08:00:05.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: "pi",
              model: "openai/gpt-5.1",
            },
            runtimeMode: "full-access",
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const next = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.turn-start-requested",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: turnRequestedAt,
          commandId: "cmd-turn-start",
          payload: {
            threadId: "thread-1",
            messageId: "message-1",
            modelSelection: {
              provider: "pi",
              model: "openai/gpt-5.5",
            },
            runtimeMode: "approval-required",
            createdAt: turnRequestedAt,
          },
        }),
      ),
    );

    expect(next.threads[0]?.modelSelection).toEqual({
      provider: "pi",
      model: "openai/gpt-5.5",
    });
    expect(next.threads[0]?.runtimeMode).toBe("approval-required");
    expect(next.threads[0]?.pendingTurnStartMessageId).toBe("message-1");
    expect(next.threads[0]?.updatedAt).toBe(turnRequestedAt);
    expect(next.threads[0]?.session).toEqual({
      threadId: "thread-1",
      status: "starting",
      providerName: "pi",
      runtimeMode: "approval-required",
      activeTurnId: null,
      lastError: null,
      updatedAt: turnRequestedAt,
    });
  });

  it("lets empty threads adopt the requested first-turn provider", async () => {
    const createdAt = "2026-02-23T08:00:00.000Z";
    const turnRequestedAt = "2026-02-23T08:00:05.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: "codex",
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const next = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.turn-start-requested",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: turnRequestedAt,
          commandId: "cmd-turn-start",
          payload: {
            threadId: "thread-1",
            messageId: "message-1",
            modelSelection: {
              provider: "opencode",
              model: "openai/gpt-5",
            },
            runtimeMode: "approval-required",
            createdAt: turnRequestedAt,
          },
        }),
      ),
    );

    expect(next.threads[0]?.modelSelection).toEqual({
      provider: "opencode",
      model: "openai/gpt-5",
    });
    expect(next.threads[0]?.session).toMatchObject({
      status: "starting",
      providerName: "opencode",
    });
  });

  it("fails when event payload cannot be decoded by runtime schema", async () => {
    const now = new Date().toISOString();
    const model = createEmptyReadModel(now);

    await expect(
      Effect.runPromise(
        projectEvent(
          model,
          makeEvent({
            sequence: 1,
            type: "thread.created",
            aggregateKind: "thread",
            aggregateId: "thread-1",
            occurredAt: now,
            commandId: "cmd-invalid",
            payload: {
              // missing required threadId
              projectId: "project-1",
              title: "demo",
              modelSelection: {
                provider: "codex",
                model: "gpt-5-codex",
              },
              createdAt: now,
              updatedAt: now,
            },
          }),
        ),
      ),
    ).rejects.toBeDefined();
  });

  it("keeps projector forward-compatible for unhandled event types", async () => {
    const now = new Date().toISOString();
    const model = createEmptyReadModel(now);

    const next = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 7,
          type: "thread.turn-interrupt-requested",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: "2026-01-01T00:00:00.000Z",
          commandId: "cmd-unhandled",
          payload: {
            threadId: "thread-1",
            messageId: "message-1",
            runtimeMode: "approval-required",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        }),
      ),
    );

    expect(next.snapshotSequence).toBe(7);
    expect(next.updatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(next.threads).toEqual([]);
  });

  it("tracks latest turn id from session lifecycle events", async () => {
    const createdAt = "2026-02-23T08:00:00.000Z";
    const startedAt = "2026-02-23T08:00:05.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: "codex",
              model: "gpt-5.3-codex",
            },
            runtimeMode: "full-access",
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const afterRunning = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.session-set",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: startedAt,
          commandId: "cmd-running",
          payload: {
            threadId: "thread-1",
            session: {
              threadId: "thread-1",
              status: "running",
              providerName: "codex",
              providerSessionId: "session-1",
              providerThreadId: "provider-thread-1",
              runtimeMode: "approval-required",
              activeTurnId: "turn-1",
              lastError: null,
              updatedAt: startedAt,
            },
          },
        }),
      ),
    );

    const thread = afterRunning.threads[0];
    expect(thread?.latestTurn?.turnId).toBe("turn-1");
    expect(thread?.session?.status).toBe("running");
  });

  it("does not settle while an interrupted session still retains the active turn", async () => {
    const createdAt = "2026-02-23T08:00:00.000Z";
    const startedAt = "2026-02-23T08:00:05.000Z";
    const stopRequestedAt = "2026-02-23T08:00:10.000Z";
    const settledAt = "2026-02-23T08:00:15.000Z";

    const afterRunning = await projectThreadWithRunningTurn({ createdAt, startedAt });

    // Stop-requested flows emit "interrupted" while keeping the turn active until
    // the provider's terminal event decides the real outcome.
    const afterStopRequested = await Effect.runPromise(
      projectEvent(
        afterRunning,
        makeSessionSetEvent({
          sequence: 3,
          commandId: "cmd-stop-requested",
          occurredAt: stopRequestedAt,
          status: "interrupted",
          activeTurnId: "turn-1",
          lastError: null,
          updatedAt: stopRequestedAt,
        }),
      ),
    );

    expect(afterStopRequested.threads[0]?.latestTurn).toMatchObject({
      turnId: "turn-1",
      state: "running",
      completedAt: null,
    });

    const afterTerminal = await Effect.runPromise(
      projectEvent(
        afterStopRequested,
        makeSessionSetEvent({
          sequence: 4,
          commandId: "cmd-terminal",
          occurredAt: settledAt,
          status: "ready",
          activeTurnId: null,
          lastError: null,
          updatedAt: settledAt,
        }),
      ),
    );

    expect(afterTerminal.threads[0]?.latestTurn).toMatchObject({
      turnId: "turn-1",
      state: "completed",
      completedAt: settledAt,
    });
  });

  it("settles an errored turn even when the session still retains the active turn", async () => {
    const createdAt = "2026-02-23T08:00:00.000Z";
    const startedAt = "2026-02-23T08:00:05.000Z";
    const erroredAt = "2026-02-23T08:00:10.000Z";

    const afterRunning = await projectThreadWithRunningTurn({ createdAt, startedAt });
    const afterError = await Effect.runPromise(
      projectEvent(
        afterRunning,
        makeSessionSetEvent({
          sequence: 3,
          commandId: "cmd-error",
          occurredAt: erroredAt,
          status: "error",
          activeTurnId: "turn-1",
          lastError: "provider crashed",
          updatedAt: erroredAt,
        }),
      ),
    );

    expect(afterError.threads[0]?.latestTurn).toMatchObject({
      turnId: "turn-1",
      state: "error",
      completedAt: erroredAt,
    });
  });

  it("updates canonical thread runtime mode from thread.runtime-mode-set", async () => {
    const createdAt = "2026-02-23T08:00:00.000Z";
    const updatedAt = "2026-02-23T08:00:05.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: "codex",
              model: "gpt-5.3-codex",
            },
            runtimeMode: "full-access",
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const afterUpdate = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.runtime-mode-set",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: updatedAt,
          commandId: "cmd-runtime-mode-set",
          payload: {
            threadId: "thread-1",
            runtimeMode: "approval-required",
            updatedAt,
          },
        }),
      ),
    );

    expect(afterUpdate.threads[0]?.runtimeMode).toBe("approval-required");
    expect(afterUpdate.threads[0]?.updatedAt).toBe(updatedAt);
  });

  it("marks assistant messages completed with non-streaming updates", async () => {
    const createdAt = "2026-02-23T09:00:00.000Z";
    const deltaAt = "2026-02-23T09:00:01.000Z";
    const completeAt = "2026-02-23T09:00:03.500Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: "codex",
              model: "gpt-5.3-codex",
            },
            runtimeMode: "full-access",
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const afterDelta = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: deltaAt,
          commandId: "cmd-delta",
          payload: {
            threadId: "thread-1",
            messageId: "assistant:msg-1",
            role: "assistant",
            text: "hello",
            turnId: "turn-1",
            streaming: true,
            createdAt: deltaAt,
            updatedAt: deltaAt,
          },
        }),
      ),
    );

    const afterComplete = await Effect.runPromise(
      projectEvent(
        afterDelta,
        makeEvent({
          sequence: 3,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: completeAt,
          commandId: "cmd-complete",
          payload: {
            threadId: "thread-1",
            messageId: "assistant:msg-1",
            role: "assistant",
            text: "",
            turnId: "turn-1",
            streaming: false,
            createdAt: completeAt,
            updatedAt: completeAt,
          },
        }),
      ),
    );

    const message = afterComplete.threads[0]?.messages[0];
    expect(message?.id).toBe("assistant:msg-1");
    expect(message?.text).toBe("hello");
    expect(message?.streaming).toBe(false);
    expect(message?.updatedAt).toBe(completeAt);
  });

  it("keeps activity order while appending and replacing without a full sort", async () => {
    const createdAt = "2026-07-09T00:00:00.000Z";
    const afterCreate = await Effect.runPromise(
      projectEvent(
        createEmptyReadModel(createdAt),
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-activity-order",
          occurredAt: createdAt,
          commandId: "cmd-thread-activity-order",
          payload: {
            threadId: "thread-activity-order",
            projectId: "project-1",
            title: "Activity order",
            modelSelection: { provider: "codex", model: "gpt-5-codex" },
            runtimeMode: "full-access",
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );
    const activityEvent = (input: { id: string; sequence: number; summary: string }) =>
      makeEvent({
        sequence: input.sequence,
        type: "thread.activity-appended",
        aggregateKind: "thread",
        aggregateId: "thread-activity-order",
        occurredAt: createdAt,
        commandId: `cmd-${input.id}-${input.summary}`,
        payload: {
          threadId: "thread-activity-order",
          activity: {
            id: input.id,
            tone: "tool",
            kind: "tool.updated",
            summary: input.summary,
            payload: {},
            turnId: null,
            sequence: input.sequence,
            createdAt,
          },
        },
      });

    const afterLate = await Effect.runPromise(
      projectEvent(
        afterCreate,
        activityEvent({ id: "activity-late", sequence: 30, summary: "late" }),
      ),
    );
    const afterEarly = await Effect.runPromise(
      projectEvent(
        afterLate,
        activityEvent({ id: "activity-early", sequence: 10, summary: "early" }),
      ),
    );
    const afterReplacement = await Effect.runPromise(
      projectEvent(
        afterEarly,
        activityEvent({ id: "activity-late", sequence: 30, summary: "late updated" }),
      ),
    );

    expect(afterReplacement.threads[0]?.activities.map((activity) => activity.id)).toEqual([
      "activity-early",
      "activity-late",
    ]);
    expect(afterReplacement.threads[0]?.activities[1]?.summary).toBe("late updated");
  });

  it("caps message retention for long-lived threads", async () => {
    const createdAt = "2026-03-01T10:00:00.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-capped",
          occurredAt: createdAt,
          commandId: "cmd-create-capped",
          payload: {
            threadId: "thread-capped",
            projectId: "project-1",
            title: "capped",
            modelSelection: {
              provider: "codex",
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const messageEvents: ReadonlyArray<OrchestrationEvent> = Array.from(
      { length: 2_100 },
      (_, index) =>
        makeEvent({
          sequence: index + 2,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-capped",
          occurredAt: `2026-03-01T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
          commandId: `cmd-message-${index}`,
          payload: {
            threadId: "thread-capped",
            messageId: `msg-${index}`,
            role: "assistant",
            text: `message-${index}`,
            turnId: `turn-${index}`,
            streaming: false,
            createdAt: `2026-03-01T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
            updatedAt: `2026-03-01T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
          },
        }),
    );
    const afterMessages = await messageEvents.reduce<
      Promise<ReturnType<typeof createEmptyReadModel>>
    >(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(afterCreate),
    );

    const finalState = afterMessages;
    const thread = finalState.threads[0];
    expect(thread?.messages).toHaveLength(2_000);
    expect(thread?.messages[0]?.id).toBe("msg-100");
    expect(thread?.messages.at(-1)?.id).toBe("msg-2099");
  });

  it("accumulates streaming deltas in place without reordering the transcript", async () => {
    const createdAt = "2026-07-20T09:00:00.000Z";
    const afterCreate = await Effect.runPromise(
      projectEvent(
        createEmptyReadModel(createdAt),
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-stream",
          occurredAt: createdAt,
          commandId: "cmd-create-stream",
          payload: {
            threadId: "thread-stream",
            projectId: "project-1",
            title: "Streaming",
            modelSelection: { provider: "codex", model: "gpt-5-codex" },
            runtimeMode: "full-access",
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const messageEvent = (input: {
      readonly sequence: number;
      readonly messageId: string;
      readonly role: "user" | "assistant";
      readonly text: string;
      readonly streaming: boolean;
      readonly turnId: string | null;
    }) =>
      makeEvent({
        sequence: input.sequence,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-stream",
        occurredAt: createdAt,
        commandId: `cmd-${input.sequence}`,
        payload: {
          threadId: "thread-stream",
          messageId: input.messageId,
          role: input.role,
          text: input.text,
          turnId: input.turnId,
          streaming: input.streaming,
          source: "native",
          createdAt,
          updatedAt: `2026-07-20T09:00:${String(input.sequence).padStart(2, "0")}.000Z`,
        },
      });

    const deltas = ["Hel", "lo, ", "wor", "ld"];
    const events = [
      messageEvent({
        sequence: 2,
        messageId: "user-1",
        role: "user",
        text: "hi",
        streaming: false,
        turnId: "turn-1",
      }),
      ...deltas.map((delta, index) =>
        messageEvent({
          sequence: 3 + index,
          messageId: "assistant-1",
          role: "assistant",
          text: delta,
          streaming: true,
          // First delta arrives without a turn binding; later deltas must not
          // rebind an already-bound message.
          turnId: index === 0 ? null : index === 3 ? "turn-other" : "turn-1",
        }),
      ),
      messageEvent({
        sequence: 7,
        messageId: "user-2",
        role: "user",
        text: "next",
        streaming: false,
        turnId: "turn-2",
      }),
      // A late delta for an earlier message must update it in place.
      messageEvent({
        sequence: 8,
        messageId: "assistant-1",
        role: "assistant",
        text: "!",
        streaming: true,
        turnId: "turn-1",
      }),
    ];

    const state = await events.reduce<Promise<ReturnType<typeof createEmptyReadModel>>>(
      (statePromise, event) =>
        statePromise.then((current) => Effect.runPromise(projectEvent(current, event))),
      Promise.resolve(afterCreate),
    );

    const thread = state.threads[0];
    expect(thread?.messages.map((message) => message.id)).toEqual([
      "user-1",
      "assistant-1",
      "user-2",
    ]);
    const assistant = thread?.messages[1];
    expect(assistant?.text).toBe(`${deltas.join("")}!`);
    expect(assistant?.streaming).toBe(true);
    expect(assistant?.turnId).toBe("turn-1");
    expect(thread?.messages[2]?.text).toBe("next");

    // The non-streaming finalization replaces the accumulated text.
    const finalized = await Effect.runPromise(
      projectEvent(
        state,
        messageEvent({
          sequence: 9,
          messageId: "assistant-1",
          role: "assistant",
          text: "Hello, world!",
          streaming: false,
          turnId: "turn-1",
        }),
      ),
    );
    expect(finalized.threads[0]?.messages.map((message) => message.id)).toEqual([
      "user-1",
      "assistant-1",
      "user-2",
    ]);
    expect(finalized.threads[0]?.messages[1]?.text).toBe("Hello, world!");
    expect(finalized.threads[0]?.messages[1]?.streaming).toBe(false);
  });
});
