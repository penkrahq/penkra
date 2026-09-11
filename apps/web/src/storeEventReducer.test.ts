// FILE: storeEventReducer.test.ts
// Purpose: Exercises orchestration domain-event reduction and batching.

import {
  ApprovalRequestId,
  CommandId,
  EventId,
  MessageId,
  FolderId,
  SpaceId,
  ThreadId,
  TurnId,
} from "@penkra/contracts";
import { describe, expect, it } from "vitest";

import { applyOrchestrationEvents, applyOrchestrationEventsHotPath } from "./storeEventReducer";
import {
  syncServerShellSnapshot,
  syncServerReadModel,
  syncServerThreadDetailHotPath,
} from "./storeProjection";
import type { AppState } from "./storeState";
import {
  makeThread,
  makeDomainEvent,
  makeActivity,
  makeState,
  makeProject,
  makeReadModelThread,
  makeReadModel,
  makeShellSnapshot,
  threadsOf,
} from "./storeTestFixtures";
import { DEFAULT_RUNTIME_MODE } from "./types";
import { createSidebarTreeThreadsSelector } from "./storeSelectors";
import { resolveThreadStatusPill } from "./components/Sidebar.logic";

describe("store event reducer", () => {
  it("registers six external creations in the sidebar without a snapshot or opened detail", () => {
    const initial = makeState(makeThread());
    const folderId = FolderId.makeUnsafe("project-1");
    const events = Array.from({ length: 6 }, (_, index) =>
      makeDomainEvent(
        "thread.created",
        {
          threadId: ThreadId.makeUnsafe(`agent-worker-${index}`),
          folderId,
          title: `Worker ${index}`,
          modelSelection: { provider: "codex", model: "gpt-5.6-sol" },
          runtimeMode: DEFAULT_RUNTIME_MODE,
          sidebarSortOrder: index,
          workingDirectory: null,
          isPinned: false,
          parentThreadId: null,
          creationSource: "penkra_mcp",
          sourceThreadId: ThreadId.makeUnsafe("thread-1"),
          subagentAgentId: null,
          subagentNickname: null,
          subagentRole: null,
          forkSourceThreadId: null,
          createdAt: "2026-09-06T00:10:00.000Z",
          updatedAt: "2026-09-06T00:10:00.000Z",
        },
        { sequence: index + 1 },
      ),
    );
    const next = applyOrchestrationEvents(initial, events);
    const rows = createSidebarTreeThreadsSelector()(next);
    expect(rows.filter((row) => row.id.startsWith("agent-worker-"))).toHaveLength(6);
    for (const event of events) {
      expect(rows.find((row) => row.id === event.payload.threadId)?.folderId).toBe(folderId);
      expect(next.threadShellById?.[event.payload.threadId]?.creationSource).toBe("penkra_mcp");
    }
    expect(applyOrchestrationEvents(next, events)).toBe(next);
    const workerId = events[0]!.payload.threadId;
    const permissionsChanged = applyOrchestrationEvents(next, [
      makeDomainEvent(
        "thread.runtime-mode-set",
        {
          threadId: workerId,
          runtimeMode: "approval-required",
          updatedAt: "2026-09-06T00:10:01.000Z",
        },
        { sequence: 7 },
      ),
    ]);
    expect(permissionsChanged.threadShellById?.[workerId]?.runtimeMode).toBe("approval-required");
    const moved = applyOrchestrationEvents(next, [
      makeDomainEvent(
        "sidebar.layout-updated",
        {
          folderUpdates: [],
          threadUpdates: [
            {
              threadId: workerId,
              folderId: FolderId.makeUnsafe("project-2"),
              sidebarSortOrder: 12,
            },
          ],
          updatedAt: "2026-09-06T00:10:01.000Z",
        },
        { sequence: 7 },
      ),
    ]);
    expect(moved.sidebarThreadSummaryById[workerId]).toMatchObject({
      folderId: "project-2",
      sidebarSortOrder: 12,
    });
    const archived = applyOrchestrationEvents(moved, [
      makeDomainEvent(
        "thread.archived",
        {
          threadId: workerId,
          archivedAt: "2026-09-06T00:10:02.000Z",
          updatedAt: "2026-09-06T00:10:02.000Z",
        },
        { sequence: 8 },
      ),
    ]);
    expect(createSidebarTreeThreadsSelector()(archived).some((row) => row.id === workerId)).toBe(
      false,
    );
    const restored = applyOrchestrationEvents(archived, [
      makeDomainEvent(
        "thread.unarchived",
        {
          threadId: workerId,
          updatedAt: "2026-09-06T00:10:03.000Z",
        },
        { sequence: 9 },
      ),
    ]);
    expect(createSidebarTreeThreadsSelector()(restored).some((row) => row.id === workerId)).toBe(
      true,
    );
    expect(
      applyOrchestrationEvents(restored, events).sidebarThreadSummaryById[workerId]?.folderId,
    ).toBe("project-2");
    const deleted = applyOrchestrationEvents(next, [
      makeDomainEvent(
        "thread.deleted",
        {
          threadId: events[0]!.payload.threadId,
          deletedAt: "2026-09-06T00:11:00.000Z",
        },
        { sequence: 10 },
      ),
    ]);
    const replayed = applyOrchestrationEvents(deleted, [events[0]!]);
    expect(
      createSidebarTreeThreadsSelector()(replayed).some(
        (row) => row.id === events[0]!.payload.threadId,
      ),
    ).toBe(false);
  });

  it("hydrates and removes empty Spaces without manufacturing null folder assignments", () => {
    const spaceId = SpaceId.makeUnsafe("space-work");
    let state = applyOrchestrationEvents(makeState(makeThread()), [
      makeDomainEvent("space.created", {
        spaceId,
        name: "Work",
        icon: "bag",
        sortOrder: 0,
        createdAt: "2026-07-15T10:00:00.000Z",
        updatedAt: "2026-07-15T10:00:00.000Z",
      }),
      makeDomainEvent("folder.moved", {
        folderId: FolderId.makeUnsafe("project-1"),
        spaceId,
        updatedAt: "2026-07-15T10:00:01.000Z",
      }),
    ]);

    expect(state.spaces.map((space) => space.id)).toEqual([spaceId]);
    expect(state.folders[0]?.spaceId).toBe(spaceId);

    state = applyOrchestrationEvents(state, [
      makeDomainEvent("space.archived", {
        spaceId,
        archivedAt: "2026-07-15T10:00:01.100Z",
      }),
    ]);
    expect(state.spaces).toEqual([]);
    state = applyOrchestrationEvents(state, [
      makeDomainEvent("space.restored", {
        spaceId,
        name: "Restored Work",
        restoredAt: "2026-07-15T10:00:01.200Z",
      }),
    ]);
    expect(state.spaces[0]).toMatchObject({ id: spaceId, name: "Restored Work", icon: "bag" });
    expect(state.archivedSpaces).toEqual([]);

    state = applyOrchestrationEvents(state, [
      makeDomainEvent("space.deleted", {
        spaceId,
        deletedAt: "2026-07-15T10:00:02.000Z",
      }),
    ]);

    expect(state.spaces).toEqual([]);
    expect(state.folders[0]?.spaceId).toBe(spaceId);
    expect(state.folders[0]?.updatedAt).toBe("2026-07-15T10:00:01.000Z");
  });

  it("preserves plugin mention references from live thread.message-sent events", () => {
    const messageId = MessageId.makeUnsafe("message-with-plugin-mention");
    const next = applyOrchestrationEvents(makeState(makeThread()), [
      makeDomainEvent("thread.message-sent", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId,
        role: "user",
        text: "Use @linear",
        attachments: [],
        mentions: [{ name: "linear", path: "plugin://linear@openai-curated" }],
        turnId: null,
        streaming: false,
        source: "native",
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:00.000Z",
      }),
    ]);

    expect(threadsOf(next)[0]?.messages[0]?.mentions).toEqual([
      { name: "linear", path: "plugin://linear@openai-curated" },
    ]);
  });

  it("keeps one sequence-fenced delivery owner from queue admission through steer acceptance", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const messageId = MessageId.makeUnsafe("message-delivery-lifecycle");
    const admitted = applyOrchestrationEvents(makeState(makeThread()), [
      makeDomainEvent(
        "thread.message-sent",
        {
          threadId,
          messageId,
          role: "user",
          text: "steer this durable follow-up",
          attachments: [],
          dispatchMode: "queue",
          delivery: { state: "queued", queued: true },
          turnId: null,
          streaming: false,
          source: "native",
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:00.000Z",
        },
        { sequence: 10 },
      ),
    ]);
    expect(threadsOf(admitted)[0]?.messages[0]?.delivery).toEqual({
      state: "queued",
      queued: true,
      sequence: 10,
    });

    const steering = applyOrchestrationEvents(admitted, [
      makeDomainEvent(
        "thread.turn-steer-queued-requested",
        { threadId, messageId, createdAt: "2026-02-27T00:00:01.000Z" },
        { sequence: 11 },
      ),
    ]);
    expect(threadsOf(steering)[0]?.messages[0]?.delivery?.state).toBe("steering");

    const accepted = applyOrchestrationEvents(steering, [
      makeDomainEvent(
        "thread.message-delivery-set",
        {
          threadId,
          messageId,
          state: "accepted",
          updatedAt: "2026-02-27T00:00:02.000Z",
        },
        { sequence: 12 },
      ),
      // A replayed older admission must not return the message to the queue.
      makeDomainEvent(
        "thread.message-sent",
        {
          threadId,
          messageId,
          role: "user",
          text: "steer this durable follow-up",
          attachments: [],
          dispatchMode: "queue",
          delivery: { state: "queued", queued: true },
          turnId: null,
          streaming: false,
          source: "native",
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:00.000Z",
        },
        { sequence: 10 },
      ),
    ]);
    expect(threadsOf(accepted)[0]?.messages).toHaveLength(1);
    expect(threadsOf(accepted)[0]?.messages[0]?.delivery).toEqual({
      state: "accepted",
      queued: true,
      sequence: 12,
    });
  });

  it("moves a runtime-requeued direct start back into the visible FIFO queue", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const messageId = MessageId.makeUnsafe("message-runtime-requeued");
    const admitted = applyOrchestrationEvents(makeState(makeThread()), [
      makeDomainEvent(
        "thread.message-sent",
        {
          threadId,
          messageId,
          role: "user",
          text: "Open up B1",
          attachments: [],
          dispatchMode: "queue",
          delivery: { state: "starting", queued: false },
          turnId: null,
          streaming: false,
          source: "native",
          createdAt: "2026-08-31T22:24:29.516Z",
          updatedAt: "2026-08-31T22:24:29.516Z",
        },
        { sequence: 20 },
      ),
    ]);

    const requeued = applyOrchestrationEvents(admitted, [
      makeDomainEvent(
        "thread.message-delivery-set",
        {
          threadId,
          messageId,
          state: "queued",
          queued: true,
          updatedAt: "2026-08-31T22:24:29.570Z",
        },
        { sequence: 21 },
      ),
    ]);

    expect(threadsOf(requeued)[0]).toMatchObject({
      pendingTurnStartMessageId: null,
      queuedMessageIds: [messageId],
      messages: [
        expect.objectContaining({
          id: messageId,
          delivery: { state: "queued", queued: true, sequence: 21 },
        }),
      ],
    });
  });

  it("projects an exact pre-dispatch failure immediately without touching accepted or successor state", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const messageId = MessageId.makeUnsafe("message-pre-dispatch-failure");
    const successorId = MessageId.makeUnsafe("message-successor");
    const turnId = TurnId.makeUnsafe("turn-pre-dispatch-failure");
    const failedAt = "2026-09-07T01:00:01.000Z";
    const failure = makeDomainEvent(
      "thread.message-delivery-set",
      {
        threadId,
        messageId,
        turnId,
        state: "failed",
        failurePhase: "before-provider-dispatch",
        failureDetail: "startup failed",
        updatedAt: failedAt,
      },
      { sequence: 12 },
    );
    const makeFailureState = (state: "starting" | "accepted") => {
      const initial = makeState(
        makeThread({
          session: {
            provider: "codex",
            status: "connecting",
            orchestrationStatus: "starting",
            activeTurnId: undefined,
            createdAt: "2026-09-07T01:00:00.000Z",
            updatedAt: "2026-09-07T01:00:00.000Z",
          },
          pendingTurnStartMessageId: messageId,
          queuedMessageIds: [successorId],
          latestTurn: {
            turnId,
            state: "running",
            requestedAt: "2026-09-07T01:00:00.000Z",
            startedAt: null,
            completedAt: null,
            assistantMessageId: null,
          },
          messages: [
            {
              id: messageId,
              role: "user",
              text: "start",
              delivery: { state, queued: false, sequence: 11 },
              streaming: false,
              source: "native",
              sequence: 11,
              createdAt: "2026-09-07T01:00:00.000Z",
            },
            {
              id: successorId,
              role: "user",
              text: "next",
              delivery: { state: "queued", queued: true, sequence: 11 },
              streaming: false,
              source: "native",
              sequence: 11,
              createdAt: "2026-09-07T01:00:00.000Z",
            },
          ],
        }),
      );
      const turnState = initial.threadTurnStateById?.[threadId];
      if (!turnState) throw new Error("Missing seeded thread turn state");
      return {
        ...initial,
        threadTurnStateById: {
          ...initial.threadTurnStateById,
          [threadId]: {
            ...turnState,
            pendingTurnStartMessageId: messageId,
            queuedMessageIds: [successorId],
          },
        },
      };
    };

    const startingState = applyOrchestrationEvents(makeFailureState("starting"), [
      makeDomainEvent(
        "thread.session-set",
        {
          threadId,
          session: {
            threadId,
            status: "starting",
            providerName: "codex",
            runtimeMode: DEFAULT_RUNTIME_MODE,
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-09-07T01:00:00.500Z",
          },
        },
        { sequence: 11 },
      ),
    ]);
    expect(startingState.sidebarThreadSummaryById[threadId]?.session?.status).toBe("connecting");
    const failedState = applyOrchestrationEvents(startingState, [failure]);
    expect(failedState.sidebarThreadSummaryById[threadId]).toMatchObject({
      session: { status: "error", orchestrationStatus: "error" },
      latestTurn: { turnId, state: "error", completedAt: failedAt },
    });
    const failed = threadsOf(failedState)[0];
    expect(failed).toMatchObject({
      pendingTurnStartMessageId: null,
      queuedMessageIds: [successorId],
      error: "startup failed",
      session: {
        status: "error",
        orchestrationStatus: "error",
        activeTurnId: undefined,
        lastError: "startup failed",
      },
      latestTurn: { turnId, state: "error", startedAt: null, completedAt: failedAt },
      messages: [
        { id: messageId, delivery: { state: "failed", sequence: 12 } },
        { id: successorId, delivery: { state: "queued", sequence: 11 } },
      ],
    });

    const accepted = threadsOf(
      applyOrchestrationEvents(makeFailureState("accepted"), [failure]),
    )[0];
    expect(accepted?.messages[0]?.delivery?.state).toBe("accepted");
    expect(accepted?.session?.status).toBe("connecting");
    expect(accepted?.latestTurn?.state).toBe("running");
    expect(accepted?.queuedMessageIds).toEqual([successorId]);

    const terminalAt = "2026-09-07T01:00:02.000Z";
    const terminalReconciliation = makeDomainEvent(
      "thread.message-delivery-set",
      {
        threadId,
        messageId,
        turnId,
        state: "accepted",
        providerTurnId: TurnId.makeUnsafe("provider-turn-failed-before-binding"),
        terminalState: "error",
        terminalCompletedAt: terminalAt,
        updatedAt: terminalAt,
      },
      { sequence: 13 },
    );
    const reconciled = threadsOf(
      applyOrchestrationEvents(makeFailureState("accepted"), [terminalReconciliation]),
    )[0];
    expect(reconciled?.latestTurn).toMatchObject({
      turnId,
      state: "error",
      completedAt: terminalAt,
    });
    expect(reconciled?.messages.find((message) => message.id === messageId)).toMatchObject({
      delivery: { state: "accepted", sequence: 13 },
    });

    const successorTurnId = TurnId.makeUnsafe("turn-live-successor");
    const successorState = makeFailureState("accepted");
    const successorThread = threadsOf(successorState)[0]!;
    successorThread.latestTurn = {
      ...successorThread.latestTurn!,
      turnId: successorTurnId,
    };
    const preserved = threadsOf(
      applyOrchestrationEvents(successorState, [terminalReconciliation]),
    )[0];
    expect(preserved?.latestTurn).toMatchObject({
      turnId: successorTurnId,
      state: "running",
      completedAt: null,
    });
  });

  it("places a promoted queued message after the assistant turn it waited behind", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const firstUserMessageId = MessageId.makeUnsafe("message-first-user");
    const queuedMessageId = MessageId.makeUnsafe("message-queued-follow-up");
    const firstAssistantMessageId = MessageId.makeUnsafe("message-first-assistant");
    const firstTurnId = TurnId.makeUnsafe("turn-first");

    const whileQueued = applyOrchestrationEvents(makeState(makeThread()), [
      makeDomainEvent(
        "thread.message-sent",
        {
          threadId,
          messageId: firstUserMessageId,
          role: "user",
          text: "Hey, what can you do?",
          attachments: [],
          turnId: firstTurnId,
          streaming: false,
          source: "native",
          createdAt: "2026-08-27T11:00:31.000Z",
          updatedAt: "2026-08-27T11:00:31.000Z",
        },
        { sequence: 1 },
      ),
      makeDomainEvent(
        "thread.message-sent",
        {
          threadId,
          messageId: queuedMessageId,
          role: "user",
          text: "Ground yourself",
          attachments: [],
          dispatchMode: "queue",
          delivery: { state: "queued", queued: true },
          turnId: TurnId.makeUnsafe("turn-queued"),
          streaming: false,
          source: "native",
          createdAt: "2026-08-27T11:00:36.000Z",
          updatedAt: "2026-08-27T11:00:36.000Z",
        },
        { sequence: 2 },
      ),
      // The provider's first visible assistant output can arrive after the
      // follow-up was admitted to the hidden durable queue.
      makeDomainEvent(
        "thread.message-sent",
        {
          threadId,
          messageId: firstAssistantMessageId,
          role: "assistant",
          text: "Quite a lot.",
          attachments: [],
          turnId: firstTurnId,
          streaming: false,
          source: "native",
          createdAt: "2026-08-27T11:00:38.000Z",
          updatedAt: "2026-08-27T11:00:40.000Z",
        },
        { sequence: 3 },
      ),
      makeDomainEvent(
        "thread.turn-queued",
        {
          threadId,
          turnId: TurnId.makeUnsafe("turn-queued"),
          messageId: queuedMessageId,
          dispatchMode: "queue",
          runtimeMode: DEFAULT_RUNTIME_MODE,
          createdAt: "2026-08-27T11:00:36.000Z",
        },
        { sequence: 4 },
      ),
    ]);

    expect(threadsOf(whileQueued)[0]?.messages.map((message) => message.id)).toEqual([
      firstUserMessageId,
      queuedMessageId,
      firstAssistantMessageId,
    ]);

    const promoted = applyOrchestrationEvents(whileQueued, [
      makeDomainEvent(
        "thread.turn-start-requested",
        {
          threadId,
          turnId: TurnId.makeUnsafe("turn-queued"),
          messageId: queuedMessageId,
          dispatchMode: "queue",
          runtimeMode: DEFAULT_RUNTIME_MODE,
          createdAt: "2026-08-27T11:00:36.000Z",
        },
        { sequence: 5 },
      ),
    ]);

    expect(threadsOf(promoted)[0]?.messages.map((message) => message.id)).toEqual([
      firstUserMessageId,
      firstAssistantMessageId,
      queuedMessageId,
    ]);
    expect(threadsOf(promoted)[0]?.messages.at(-1)?.delivery).toEqual({
      state: "starting",
      queued: true,
      sequence: 5,
    });
  });

  it("removes only the cancelled pre-acceptance prompt and clears its pending identity", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const pendingMessageId = MessageId.makeUnsafe("message-pending-start");
    const retainedMessageId = MessageId.makeUnsafe("message-retained");
    const stateWithPendingStart = applyOrchestrationEvents(makeState(makeThread()), [
      makeDomainEvent("thread.message-sent", {
        threadId,
        messageId: retainedMessageId,
        role: "user",
        text: "keep me",
        attachments: [],
        turnId: null,
        streaming: false,
        source: "native",
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:00.000Z",
      }),
      makeDomainEvent("thread.message-sent", {
        threadId,
        messageId: pendingMessageId,
        role: "user",
        text: "cancel me",
        attachments: [],
        turnId: null,
        streaming: false,
        source: "native",
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
      makeDomainEvent("thread.turn-start-requested", {
        threadId,
        messageId: pendingMessageId,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        dispatchMode: "queue",
        createdAt: "2026-02-27T00:00:01.000Z",
      }),
    ]);

    expect(threadsOf(stateWithPendingStart)[0]?.pendingTurnStartMessageId).toBe(pendingMessageId);

    const successorMessageId = MessageId.makeUnsafe("message-successor-start");
    const stateWithSuccessorPending = applyOrchestrationEvents(stateWithPendingStart, [
      makeDomainEvent("thread.message-sent", {
        threadId,
        messageId: successorMessageId,
        role: "user",
        text: "run next",
        attachments: [],
        turnId: null,
        streaming: false,
        source: "native",
        createdAt: "2026-02-27T00:00:01.500Z",
        updatedAt: "2026-02-27T00:00:01.500Z",
      }),
      makeDomainEvent("thread.turn-start-requested", {
        threadId,
        messageId: successorMessageId,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        dispatchMode: "queue",
        createdAt: "2026-02-27T00:00:01.500Z",
      }),
    ]);
    const olderCancellationAfterSuccessor = applyOrchestrationEvents(stateWithSuccessorPending, [
      makeDomainEvent("thread.turn-start-cancelled", {
        threadId,
        messageId: pendingMessageId,
        cancelledAt: "2026-02-27T00:00:02.000Z",
      }),
    ]);
    expect(threadsOf(olderCancellationAfterSuccessor)[0]?.pendingTurnStartMessageId).toBe(
      successorMessageId,
    );

    const cancelled = applyOrchestrationEvents(stateWithPendingStart, [
      makeDomainEvent("thread.turn-start-cancelled", {
        threadId,
        messageId: pendingMessageId,
        cancelledAt: "2026-02-27T00:00:02.000Z",
      }),
    ]);

    expect(threadsOf(cancelled)[0]?.messages.map((message) => message.id)).toEqual([
      retainedMessageId,
    ]);
    expect(threadsOf(cancelled)[0]?.pendingTurnStartMessageId).toBeNull();
    expect(cancelled.pendingStartCancellationByThreadId?.[threadId]).toEqual({
      messageId: pendingMessageId,
      sequence: expect.any(Number),
    });
  });

  it("does not mark a normally accepted pending message as cancelled", () => {
    const threadId = ThreadId.makeUnsafe("thread-accepted-pending-start");
    const messageId = MessageId.makeUnsafe("message-accepted-pending-start");
    const accepted = applyOrchestrationEvents(makeState(makeThread({ id: threadId })), [
      makeDomainEvent("thread.message-sent", {
        threadId,
        messageId,
        role: "user",
        text: "keep accepted history",
        attachments: [],
        turnId: null,
        streaming: false,
        source: "native",
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:00.000Z",
      }),
      makeDomainEvent("thread.message-delivery-set", {
        threadId,
        messageId,
        state: "accepted",
        queued: false,
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    ]);

    expect(threadsOf(accepted)[0]?.messages.map((message) => message.id)).toContain(messageId);
    expect(accepted.pendingStartCancellationByThreadId?.[threadId]).toBeUndefined();
  });

  it("bounds cancellation reconciliation to one signal per retained thread", () => {
    const threadId = ThreadId.makeUnsafe("thread-bounded-cancellation");
    const firstMessageId = MessageId.makeUnsafe("message-first-cancellation");
    const latestMessageId = MessageId.makeUnsafe("message-latest-cancellation");
    const cancelled = applyOrchestrationEvents(makeState(makeThread({ id: threadId })), [
      makeDomainEvent(
        "thread.turn-start-cancelled",
        { threadId, messageId: firstMessageId, cancelledAt: "2026-02-27T00:00:01.000Z" },
        { sequence: 10 },
      ),
      makeDomainEvent(
        "thread.turn-start-cancelled",
        { threadId, messageId: latestMessageId, cancelledAt: "2026-02-27T00:00:02.000Z" },
        { sequence: 11 },
      ),
    ]);

    expect(cancelled.pendingStartCancellationByThreadId).toEqual({
      [threadId]: { messageId: latestMessageId, sequence: 11 },
    });

    const boundedSnapshotWithoutThread = syncServerReadModel(cancelled, {
      ...makeReadModel(makeReadModelThread({ id: threadId })),
      snapshotSequence: 12,
      threads: [],
    });
    expect(boundedSnapshotWithoutThread.pendingStartCancellationByThreadId).toEqual(
      cancelled.pendingStartCancellationByThreadId,
    );

    const deleted = applyOrchestrationEvents(cancelled, [
      makeDomainEvent(
        "thread.deleted",
        { threadId, deletedAt: "2026-02-27T00:00:03.000Z" },
        { sequence: 12 },
      ),
    ]);
    expect(deleted.pendingStartCancellationByThreadId).toEqual({});
  });

  it("settles cancellation ownership by exact thread and message identity", () => {
    const firstThreadId = ThreadId.makeUnsafe("thread-shared-message-first");
    const secondThreadId = ThreadId.makeUnsafe("thread-shared-message-second");
    const sharedMessageId = MessageId.makeUnsafe("message-shared-across-threads");
    const initial = applyOrchestrationEvents(makeState(makeThread({ id: firstThreadId })), [
      makeDomainEvent("thread.created", {
        threadId: secondThreadId,
        folderId: FolderId.makeUnsafe("project-1"),
        title: "Second thread",
        modelSelection: { provider: "codex", model: "gpt-5.6-sol" },
        runtimeMode: DEFAULT_RUNTIME_MODE,
        sidebarSortOrder: 1,
        workingDirectory: null,
        isPinned: false,
        parentThreadId: null,
        creationSource: null,
        sourceThreadId: null,
        subagentAgentId: null,
        subagentNickname: null,
        subagentRole: null,
        forkSourceThreadId: null,
        createdAt: "2026-09-07T00:00:00.000Z",
        updatedAt: "2026-09-07T00:00:00.000Z",
      }),
    ]);
    const cancelled = applyOrchestrationEvents(initial, [
      makeDomainEvent("thread.turn-start-cancelled", {
        threadId: firstThreadId,
        messageId: sharedMessageId,
        cancelledAt: "2026-09-07T00:00:01.000Z",
      }),
      makeDomainEvent("thread.turn-start-cancelled", {
        threadId: secondThreadId,
        messageId: sharedMessageId,
        cancelledAt: "2026-09-07T00:00:02.000Z",
      }),
    ]);
    const firstAccepted = applyOrchestrationEvents(cancelled, [
      makeDomainEvent("thread.message-delivery-set", {
        threadId: firstThreadId,
        messageId: sharedMessageId,
        state: "accepted",
        queued: false,
        updatedAt: "2026-09-07T00:00:03.000Z",
      }),
    ]);
    expect(firstAccepted.pendingStartCancellationByThreadId?.[firstThreadId]).toBeUndefined();
    expect(firstAccepted.pendingStartCancellationByThreadId?.[secondThreadId]?.messageId).toBe(
      sharedMessageId,
    );
    const firstDeleted = applyOrchestrationEvents(cancelled, [
      makeDomainEvent("thread.deleted", {
        threadId: firstThreadId,
        deletedAt: "2026-09-07T00:00:04.000Z",
      }),
    ]);
    expect(firstDeleted.pendingStartCancellationByThreadId?.[firstThreadId]).toBeUndefined();
    expect(firstDeleted.pendingStartCancellationByThreadId?.[secondThreadId]?.messageId).toBe(
      sharedMessageId,
    );
  });

  it("updates thread error and marks the running latest turn failed from session-set events", () => {
    const initialState = makeState(
      makeThread({
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-running"),
          state: "running",
          requestedAt: "2026-02-27T00:01:00.000Z",
          startedAt: "2026-02-27T00:01:05.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      }),
    );

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.session-set", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "error",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: "provider crashed",
          updatedAt: "2026-02-27T00:02:00.000Z",
        },
      }),
    ]);

    expect(threadsOf(next)[0]?.error).toBe("provider crashed");
    expect(threadsOf(next)[0]?.latestTurn).toMatchObject({
      turnId: TurnId.makeUnsafe("turn-running"),
      state: "error",
      completedAt: "2026-02-27T00:02:00.000Z",
    });
  });

  it("does not settle the running turn while an interrupted session still retains it", () => {
    const initialState = makeState(
      makeThread({
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-running"),
          state: "running",
          requestedAt: "2026-02-27T00:01:00.000Z",
          startedAt: "2026-02-27T00:01:05.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      }),
    );

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.session-set", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "interrupted",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: TurnId.makeUnsafe("turn-running"),
          lastError: null,
          updatedAt: "2026-02-27T00:02:00.000Z",
        },
      }),
    ]);

    expect(threadsOf(next)[0]?.latestTurn).toMatchObject({
      turnId: TurnId.makeUnsafe("turn-running"),
      state: "running",
      completedAt: null,
    });
  });

  it("preserves the canonical latest turn when the running session uses its provider ID", () => {
    const canonicalTurnId = TurnId.makeUnsafe("turn-request");
    const providerTurnId = TurnId.makeUnsafe("turn-provider");
    const initialState = makeState(
      makeThread({
        latestTurn: {
          turnId: canonicalTurnId,
          providerTurnId,
          state: "running",
          requestedAt: "2026-02-27T00:01:00.000Z",
          startedAt: "2026-02-27T00:01:05.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      }),
    );

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.session-set", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: providerTurnId,
          lastError: null,
          updatedAt: "2026-02-27T00:02:00.000Z",
        },
      }),
    ]);

    expect(threadsOf(next)[0]?.latestTurn).toMatchObject({
      turnId: canonicalTurnId,
      providerTurnId,
      state: "running",
    });
  });

  it.each([
    { label: "initial", session: null },
    {
      label: "reopened",
      session: {
        provider: "codex" as const,
        status: "ready" as const,
        orchestrationStatus: "ready" as const,
        activeTurnId: undefined,
        createdAt: "2026-02-27T00:01:00.000Z",
        updatedAt: "2026-02-27T00:01:00.000Z",
      },
    },
  ])("keeps an admitted $label turn working across ready bootstrap", ({ session }) => {
    const threadId = ThreadId.makeUnsafe(
      `thread-ready-bootstrap-${session ? "reopened" : "initial"}`,
    );
    const messageId = MessageId.makeUnsafe(
      `message-ready-bootstrap-${session ? "reopened" : "initial"}`,
    );
    const previousTurnId = TurnId.makeUnsafe("turn-previous-completed");
    const initialState = makeState(
      makeThread({
        id: threadId,
        session,
        latestTurn: {
          turnId: previousTurnId,
          state: "completed",
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:01.000Z",
          completedAt: "2026-02-27T00:00:02.000Z",
          assistantMessageId: null,
        },
      }),
    );
    const admitted = applyOrchestrationEvents(initialState, [
      makeDomainEvent(
        "thread.turn-start-requested",
        {
          threadId,
          messageId,
          turnId: TurnId.makeUnsafe(`turn-new-${session ? "reopened" : "initial"}`),
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: DEFAULT_RUNTIME_MODE,
          dispatchMode: "queue",
          createdAt: "2026-02-27T00:01:03.000Z",
        },
        { sequence: 10, occurredAt: "2026-02-27T00:01:03.000Z" },
      ),
    ]);
    expect(threadsOf(admitted)[0]?.pendingTurnStartMessageId).toBe(messageId);

    const ready = applyOrchestrationEvents(admitted, [
      makeDomainEvent(
        "thread.session-set",
        {
          threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: DEFAULT_RUNTIME_MODE,
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-02-27T00:01:03.100Z",
          },
        },
        { sequence: 11, occurredAt: "2026-02-27T00:01:03.100Z" },
      ),
    ]);

    const thread = threadsOf(ready)[0];
    expect(thread?.pendingTurnStartMessageId).toBe(messageId);
    expect(thread?.latestTurn).toMatchObject({
      turnId: previousTurnId,
      state: "completed",
    });
    const summary = ready.sidebarThreadSummaryById[threadId];
    expect(summary).toBeDefined();
    expect(
      resolveThreadStatusPill({
        thread: summary!,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toMatchObject({ label: "Working", pulse: true });
  });

  it.each([
    { status: "running" as const, activeTurnId: TurnId.makeUnsafe("turn-running") },
    { status: "stopped" as const, activeTurnId: null },
    { status: "interrupted" as const, activeTurnId: TurnId.makeUnsafe("turn-interrupted") },
    { status: "error" as const, activeTurnId: null },
  ])("retires an admitted marker when the session becomes $status", ({ status, activeTurnId }) => {
    const threadId = ThreadId.makeUnsafe(`thread-retire-${status}`);
    const messageId = MessageId.makeUnsafe(`message-retire-${status}`);
    const initialState = makeState(
      makeThread({
        id: threadId,
        pendingTurnStartMessageId: messageId,
        session: {
          provider: "codex",
          status: "closed",
          orchestrationStatus: "stopped",
          activeTurnId: undefined,
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:00.000Z",
        },
      }),
    );

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.session-set", {
        threadId,
        session: {
          threadId,
          status,
          providerName: "codex",
          runtimeMode: DEFAULT_RUNTIME_MODE,
          activeTurnId,
          lastError: status === "error" ? "provider crashed" : null,
          updatedAt: "2026-02-27T00:00:01.000Z",
        },
      }),
    ]);

    expect(threadsOf(next)[0]?.pendingTurnStartMessageId).toBeNull();
  });

  it.each(["codex", "claudeAgent"] as const)(
    "does not leave a promoted %s steer working after its running provider turn completes",
    (provider) => {
      const threadId = ThreadId.makeUnsafe("thread-promoted-steer-completed");
      const messageId = MessageId.makeUnsafe("composer-queue:promoted-steer");
      const providerTurnId = TurnId.makeUnsafe("provider-turn-running");
      const initialState = makeState(
        makeThread({
          id: threadId,
          modelSelection: { provider, model: "provider-model" },
          session: {
            provider,
            status: "running",
            orchestrationStatus: "running",
            activeTurnId: providerTurnId,
            createdAt: "2026-09-11T09:09:01.000Z",
            updatedAt: "2026-09-11T09:09:01.000Z",
          },
          latestTurn: {
            turnId: providerTurnId,
            state: "running",
            requestedAt: "2026-09-11T09:09:00.000Z",
            startedAt: "2026-09-11T09:09:01.000Z",
            completedAt: null,
            assistantMessageId: null,
          },
        }),
      );

      const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent(
        "thread.message-sent",
        {
          threadId,
          messageId,
          role: "user",
          text: "promote me",
          attachments: [],
          dispatchMode: "queue",
          dispatchOrigin: "user",
          delivery: { state: "queued", queued: true },
          turnId: TurnId.makeUnsafe(`turn:${messageId}`),
          streaming: false,
          source: "native",
          createdAt: "2026-09-11T09:09:34.640Z",
          updatedAt: "2026-09-11T09:09:34.640Z",
        },
        { sequence: 3 },
      ),
      makeDomainEvent(
        "thread.turn-queued",
        {
          threadId,
          turnId: TurnId.makeUnsafe(`turn:${messageId}`),
          messageId,
          restartRecovery: false,
          dispatchMode: "queue",
          dispatchOrigin: "user",
          runtimeMode: DEFAULT_RUNTIME_MODE,
          createdAt: "2026-09-11T09:09:34.640Z",
        },
        { sequence: 4 },
      ),
      makeDomainEvent(
        "thread.turn-steer-queued-requested",
        {
          threadId,
          messageId,
          createdAt: "2026-09-11T09:09:36.168Z",
        },
        { sequence: 5 },
      ),
      makeDomainEvent(
        "thread.turn-start-requested",
        {
          threadId,
          turnId: TurnId.makeUnsafe("turn-promoted-steer"),
          messageId,
          restartRecovery: false,
          runtimeMode: DEFAULT_RUNTIME_MODE,
          dispatchMode: "steer",
          dispatchOrigin: "user",
          createdAt: "2026-09-11T09:09:36.168Z",
        },
        { sequence: 6 },
      ),
      makeDomainEvent(
        "thread.message-delivery-set",
        {
          threadId,
          messageId,
          turnId: TurnId.makeUnsafe("turn-promoted-steer"),
          state: "accepted",
          providerTurnId,
          updatedAt: "2026-09-11T09:09:38.620Z",
        },
        { sequence: 7 },
      ),
      makeDomainEvent(
        "thread.session-set",
        {
          threadId,
          session: {
            threadId,
            status: "ready",
            providerName: provider,
            runtimeMode: DEFAULT_RUNTIME_MODE,
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-09-11T09:10:20.236Z",
          },
        },
        { sequence: 8, occurredAt: "2026-09-11T09:10:20.236Z" },
      ),
      ]);

      const thread = threadsOf(next)[0];
      expect(thread?.pendingTurnStartMessageId).toBeNull();
      expect(thread?.latestTurn?.state).toBe("completed");
      expect(
        resolveThreadStatusPill({
          thread: next.sidebarThreadSummaryById[threadId]!,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
        }),
      ).toMatchObject({ label: "Completed", pulse: false });
    },
  );

  it("keeps an OpenCode replacement steer pending until its new provider turn starts", () => {
    const threadId = ThreadId.makeUnsafe("thread-opencode-replacement-steer");
    const messageId = MessageId.makeUnsafe("message-opencode-replacement-steer");
    const initialState = makeState(
      makeThread({
        id: threadId,
        modelSelection: { provider: "opencode", model: "openai/gpt-5" },
        session: {
          provider: "opencode",
          status: "running",
          orchestrationStatus: "running",
          activeTurnId: TurnId.makeUnsafe("provider-turn-before-interrupt"),
          createdAt: "2026-09-11T10:00:00.000Z",
          updatedAt: "2026-09-11T10:00:00.000Z",
        },
      }),
    );
    const admitted = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.turn-start-requested", {
        threadId,
        turnId: TurnId.makeUnsafe("turn-opencode-replacement-steer"),
        messageId,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        dispatchMode: "steer",
        createdAt: "2026-09-11T10:00:02.000Z",
      }),
    ]);

    expect(threadsOf(admitted)[0]?.pendingTurnStartMessageId).toBe(messageId);
  });

  it.each([
    { status: "ready", expectedState: "completed" },
    { status: "interrupted", expectedState: "interrupted" },
    { status: "stopped", expectedState: "interrupted" },
  ] as const)(
    "settles the running latest turn when a session-set event leaves running ($status → $expectedState)",
    ({ status, expectedState }) => {
      const initialState = makeState(
        makeThread({
          latestTurn: {
            turnId: TurnId.makeUnsafe("turn-running"),
            state: "running",
            requestedAt: "2026-02-27T00:01:00.000Z",
            startedAt: "2026-02-27T00:01:05.000Z",
            completedAt: null,
            assistantMessageId: null,
          },
        }),
      );

      const next = applyOrchestrationEvents(initialState, [
        makeDomainEvent("thread.session-set", {
          threadId: ThreadId.makeUnsafe("thread-1"),
          session: {
            threadId: ThreadId.makeUnsafe("thread-1"),
            status,
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-02-27T00:02:00.000Z",
          },
        }),
      ]);

      expect(threadsOf(next)[0]?.latestTurn).toMatchObject({
        turnId: TurnId.makeUnsafe("turn-running"),
        state: expectedState,
        completedAt: "2026-02-27T00:02:00.000Z",
      });
    },
  );

  it("adds folders immediately from live folder.created events", () => {
    const next = applyOrchestrationEvents(
      {
        spaces: [],
        archivedSpaces: [],
        folders: [],
        archivedFolders: [],
        sidebarThreadSummaryById: {},
        threadsHydrated: false,
      },
      [
        makeDomainEvent(
          "folder.created",
          {
            folderId: FolderId.makeUnsafe("project-live"),
            spaceId: SpaceId.makeUnsafe("space-test"),
            title: "Live Project",
            workspaceRoot: "/tmp/live-project",
            defaultModelSelection: {
              provider: "codex",
              model: "gpt-5-codex",
            },
            scripts: [],
            createdAt: "2026-02-27T00:00:00.000Z",
            updatedAt: "2026-02-27T00:00:00.000Z",
          },
          { aggregateKind: "folder" },
        ),
      ],
    );

    expect(next.folders).toHaveLength(1);
    expect(next.folders[0]).toMatchObject({
      id: FolderId.makeUnsafe("project-live"),
      name: "Live Project",
      remoteName: "Live Project",
      folderName: "live-project",
      cwd: "/tmp/live-project",
      createdAt: "2026-02-27T00:00:00.000Z",
      updatedAt: "2026-02-27T00:00:00.000Z",
    });
  });

  it("normalizes a virtual folder without inventing a physical cwd", () => {
    const next = applyOrchestrationEvents(
      {
        spaces: [],
        archivedSpaces: [],
        folders: [],
        archivedFolders: [],
        sidebarThreadSummaryById: {},
        threadsHydrated: false,
      },
      [
        makeDomainEvent(
          "folder.created",
          {
            folderId: FolderId.makeUnsafe("folder-virtual"),
            spaceId: SpaceId.makeUnsafe("space-test"),
            title: "Ideas",
            workspaceRoot: null,
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-08-02T00:00:00.000Z",
            updatedAt: "2026-08-02T00:00:00.000Z",
          },
          { aggregateKind: "folder" },
        ),
      ],
    );

    expect(next.folders[0]).toMatchObject({
      name: "Ideas",
      folderName: "Ideas",
      cwd: "",
    });
  });

  it("adopts authoritative folder titles from live folder.updated events", () => {
    const initialState: AppState = {
      spaces: [],
      archivedSpaces: [],
      folders: [
        makeProject({
          id: FolderId.makeUnsafe("project-live"),
          name: "Local Name",
          remoteName: "Original Name",
          localName: "Local Name",
          folderName: "original-project",
          cwd: "/tmp/original-project",
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:00.000Z",
        }),
      ],
      archivedFolders: [],
      sidebarThreadSummaryById: {},
      threadsHydrated: true,
    };

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent(
        "folder.updated",
        {
          folderId: FolderId.makeUnsafe("project-live"),
          title: "Renamed Remotely",
          workspaceRoot: "/tmp/renamed-project",
          defaultModelSelection: null,
          scripts: [
            {
              id: "lint",
              name: "Lint",
              command: "bun lint",
              icon: "lint",
            },
          ],
          updatedAt: "2026-02-27T00:05:00.000Z",
        },
        { aggregateKind: "folder" },
      ),
    ]);

    expect(next.folders[0]).toMatchObject({
      id: FolderId.makeUnsafe("project-live"),
      name: "Renamed Remotely",
      remoteName: "Renamed Remotely",
      folderName: "renamed-project",
      localName: null,
      cwd: "/tmp/renamed-project",
      defaultModelSelection: null,
      updatedAt: "2026-02-27T00:05:00.000Z",
      scripts: [
        {
          id: "lint",
          name: "Lint",
          command: "bun lint",
          icon: "lint",
        },
      ],
    });
  });

  it("removes folders immediately from live folder.deleted events", () => {
    const next = applyOrchestrationEvents(
      {
        spaces: [],
        archivedSpaces: [],
        folders: [makeProject({ id: FolderId.makeUnsafe("project-live") })],
        archivedFolders: [],
        sidebarThreadSummaryById: {},
        threadsHydrated: true,
      },
      [
        makeDomainEvent(
          "folder.deleted",
          {
            folderId: FolderId.makeUnsafe("project-live"),
            deletedAt: "2026-02-27T00:06:00.000Z",
          },
          { aggregateKind: "folder" },
        ),
      ],
    );

    expect(next.folders).toEqual([]);
    expect(next.deletedFolderIdsById?.[FolderId.makeUnsafe("project-live")]).toEqual(
      expect.any(Number),
    );
  });

  it("settles a running latest turn immediately when session stop is requested", () => {
    const initialState = makeState(
      makeThread({
        session: {
          provider: "codex",
          status: "running",
          orchestrationStatus: "running",
          activeTurnId: TurnId.makeUnsafe("turn-running"),
          createdAt: "2026-02-27T00:01:00.000Z",
          updatedAt: "2026-02-27T00:01:00.000Z",
        },
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-running"),
          state: "running",
          requestedAt: "2026-02-27T00:01:00.000Z",
          startedAt: "2026-02-27T00:01:05.000Z",
          completedAt: null,
          assistantMessageId: MessageId.makeUnsafe("assistant-running"),
        },
      }),
    );

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.session-stop-requested", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        createdAt: "2026-02-27T00:02:00.000Z",
      }),
    ]);

    expect(threadsOf(next)[0]?.session).toMatchObject({
      status: "closed",
      orchestrationStatus: "stopped",
      activeTurnId: undefined,
      updatedAt: "2026-02-27T00:02:00.000Z",
    });
    expect(threadsOf(next)[0]?.latestTurn).toMatchObject({
      turnId: TurnId.makeUnsafe("turn-running"),
      state: "interrupted",
      requestedAt: "2026-02-27T00:01:00.000Z",
      startedAt: "2026-02-27T00:01:05.000Z",
      completedAt: "2026-02-27T00:02:00.000Z",
      assistantMessageId: MessageId.makeUnsafe("assistant-running"),
    });
  });

  it("keeps the latest turn running when interrupt is only requested", () => {
    const initialState = makeState(
      makeThread({
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-running"),
          state: "running",
          requestedAt: "2026-02-27T00:01:00.000Z",
          startedAt: "2026-02-27T00:01:05.000Z",
          completedAt: null,
          assistantMessageId: MessageId.makeUnsafe("assistant-running"),
        },
      }),
    );

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.turn-interrupt-requested", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: TurnId.makeUnsafe("turn-running"),
        createdAt: "2026-02-27T00:02:00.000Z",
      }),
    ]);

    expect(threadsOf(next)[0]?.latestTurn).toMatchObject({
      turnId: TurnId.makeUnsafe("turn-running"),
      state: "running",
      requestedAt: "2026-02-27T00:01:00.000Z",
      startedAt: "2026-02-27T00:01:05.000Z",
      completedAt: null,
      assistantMessageId: MessageId.makeUnsafe("assistant-running"),
    });
  });

  it("adopts runtime mode from user-dispatched turns", () => {
    const initialState = makeState(makeThread({ runtimeMode: "approval-required" }));

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.turn-start-requested", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: MessageId.makeUnsafe("user-message"),
        runtimeMode: "full-access",
        dispatchMode: "queue",
        dispatchOrigin: "user",
        createdAt: "2026-02-27T00:01:00.000Z",
      }),
    ]);

    expect(threadsOf(next)[0]?.runtimeMode).toBe("full-access");
  });

  it("does not truncate streamed assistant text when completion only carries the trailing chunk", () => {
    const assistantId = MessageId.makeUnsafe("assistant-message");
    const turnId = TurnId.makeUnsafe("turn-1");
    const initialState = makeState(
      makeThread({
        messages: [
          {
            id: assistantId,
            role: "assistant",
            text: "Hello",
            turnId,
            createdAt: "2026-02-27T00:01:05.000Z",
            streaming: true,
            source: "native",
          },
        ],
        latestTurn: {
          turnId,
          state: "running",
          requestedAt: "2026-02-27T00:01:00.000Z",
          startedAt: "2026-02-27T00:01:05.000Z",
          completedAt: null,
          assistantMessageId: assistantId,
        },
      }),
    );

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.message-sent", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: assistantId,
        role: "assistant",
        text: " world",
        turnId,
        streaming: false,
        createdAt: "2026-02-27T00:01:05.000Z",
        updatedAt: "2026-02-27T00:01:06.000Z",
        attachments: [],
        source: "native",
      }),
    ]);

    expect(threadsOf(next)[0]?.messages).toMatchObject([
      {
        id: assistantId,
        text: "Hello world",
        streaming: false,
        completedAt: "2026-02-27T00:01:06.000Z",
      },
    ]);
  });

  it("replaces a non-streaming user message when an active-tail edit reuses its message id", () => {
    const userId = MessageId.makeUnsafe("user-active-edit");
    const initialState = makeState(
      makeThread({
        messages: [
          {
            id: userId,
            role: "user",
            text: "old prompt",
            turnId: null,
            createdAt: "2026-02-27T00:01:00.000Z",
            streaming: false,
            source: "native",
          },
        ],
      }),
    );

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.message-sent", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: userId,
        role: "user",
        text: "edited prompt",
        turnId: null,
        streaming: false,
        createdAt: "2026-02-27T00:01:00.000Z",
        updatedAt: "2026-02-27T00:01:05.000Z",
        attachments: [],
        source: "native",
      }),
    ]);

    expect(threadsOf(next)[0]?.messages).toMatchObject([
      {
        id: userId,
        text: "edited prompt",
        streaming: false,
      },
    ]);
  });

  it("applies thread metadata immediately during live updates", () => {
    const initialState = makeState(
      makeThread({
        title: "Old title",
        session: {
          provider: "codex",
          status: "ready",
          orchestrationStatus: "ready",
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:00.000Z",
        },
      }),
    );

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.updated", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        title: "New title",
        lastVisitedAt: "2026-02-27T00:00:45.000Z",
        updatedAt: "2026-02-27T00:01:00.000Z",
      }),
    ]);

    expect(threadsOf(next)[0]).toMatchObject({
      title: "New title",
      lastVisitedAt: "2026-02-27T00:00:45.000Z",
      updatedAt: "2026-02-27T00:01:00.000Z",
    });
  });

  it("propagates a live read acknowledgement into the sidebar summary", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const initialState = syncServerReadModel(
      makeState(makeThread({ lastVisitedAt: "2026-02-27T00:00:00.000Z" })),
      makeReadModel(
        makeReadModelThread({
          lastVisitedAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:30.000Z",
        }),
      ),
    );

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.updated", {
        threadId,
        lastVisitedAt: "2026-02-27T00:01:00.000Z",
        updatedAt: "2026-02-27T00:01:00.000Z",
      }),
    ]);

    expect(next.sidebarThreadSummaryById[threadId]?.lastVisitedAt).toBe("2026-02-27T00:01:00.000Z");
    expect(threadsOf(next)[0]?.lastVisitedAt).toBe("2026-02-27T00:01:00.000Z");
  });

  it("surfaces pinnedMessages and notes from a live thread.updated event", () => {
    const initialState = makeState(makeThread());
    const messageId = MessageId.makeUnsafe("assistant-pin-2");
    const pinnedMessages = [
      {
        messageId,
        label: "Check the migration",
        done: false,
        pinnedAt: "2026-02-27T00:02:00.000Z",
      },
    ];

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.updated", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        pinnedMessages,
        notes: "scratch",
        updatedAt: "2026-02-27T00:02:00.000Z",
      }),
    ]);

    expect(threadsOf(next)[0]?.pinnedMessages).toEqual(pinnedMessages);
    expect(threadsOf(next)[0]?.notes).toBe("scratch");
  });

  it("applies live pinned-message operation events without replacing the whole list", () => {
    const initialState = makeState(makeThread());
    const firstMessageId = MessageId.makeUnsafe("assistant-pin-op-1");
    const secondMessageId = MessageId.makeUnsafe("assistant-pin-op-2");

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.pinned-message-added", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        pin: {
          messageId: firstMessageId,
          label: null,
          done: false,
          pinnedAt: "2026-02-27T00:03:00.000Z",
        },
        updatedAt: "2026-02-27T00:03:00.000Z",
      }),
      makeDomainEvent("thread.pinned-message-added", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        pin: {
          messageId: secondMessageId,
          label: null,
          done: false,
          pinnedAt: "2026-02-27T00:03:05.000Z",
        },
        updatedAt: "2026-02-27T00:03:05.000Z",
      }),
      makeDomainEvent("thread.pinned-message-done-set", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: firstMessageId,
        done: true,
        updatedAt: "2026-02-27T00:03:10.000Z",
      }),
      makeDomainEvent("thread.pinned-message-label-set", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: firstMessageId,
        label: "Follow up",
        updatedAt: "2026-02-27T00:03:15.000Z",
      }),
      makeDomainEvent("thread.pinned-message-removed", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: secondMessageId,
        updatedAt: "2026-02-27T00:03:20.000Z",
      }),
    ]);

    expect(threadsOf(next)[0]?.pinnedMessages).toEqual([
      {
        messageId: firstMessageId,
        label: "Follow up",
        done: true,
        pinnedAt: "2026-02-27T00:03:00.000Z",
      },
    ]);
    expect(threadsOf(next)[0]?.updatedAt).toBe("2026-02-27T00:03:20.000Z");
  });

  it("rolls back conversation state from an edited user message", () => {
    const initialState = makeState(
      makeThread({
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-2"),
          state: "completed",
          requestedAt: "2026-02-27T00:01:00.000Z",
          startedAt: "2026-02-27T00:01:05.000Z",
          completedAt: "2026-02-27T00:03:00.000Z",
          assistantMessageId: MessageId.makeUnsafe("assistant-2"),
        },
        messages: [
          {
            id: MessageId.makeUnsafe("user-1"),
            role: "user",
            text: "one",
            turnId: TurnId.makeUnsafe("turn-1"),
            createdAt: "2026-02-27T00:00:00.000Z",
            streaming: false,
          },
          {
            id: MessageId.makeUnsafe("assistant-1"),
            role: "assistant",
            text: "reply one",
            turnId: TurnId.makeUnsafe("turn-1"),
            createdAt: "2026-02-27T00:00:10.000Z",
            streaming: false,
          },
          {
            id: MessageId.makeUnsafe("user-2"),
            role: "user",
            text: "two",
            turnId: TurnId.makeUnsafe("turn-2"),
            createdAt: "2026-02-27T00:01:00.000Z",
            streaming: false,
          },
          {
            id: MessageId.makeUnsafe("assistant-2"),
            role: "assistant",
            text: "reply two",
            turnId: TurnId.makeUnsafe("turn-2"),
            createdAt: "2026-02-27T00:01:10.000Z",
            streaming: false,
          },
        ],
        activities: [makeActivity({ id: "activity-2", turnId: "turn-2" })],
      }),
    );

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.conversation-rolled-back", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: MessageId.makeUnsafe("user-2"),
        numTurns: 1,
        removedTurnIds: [TurnId.makeUnsafe("turn-2")],
      }),
    ]);

    expect(threadsOf(next)[0]?.messages.map((message) => message.id)).toEqual([
      MessageId.makeUnsafe("user-1"),
      MessageId.makeUnsafe("assistant-1"),
    ]);
    expect(threadsOf(next)[0]?.activities).toEqual([]);
    expect(threadsOf(next)[0]?.latestTurn).toBeNull();
  });

  it("reconciles snapshot state even when thread updatedAt matches a prior live event", () => {
    const liveState = applyOrchestrationEvents(makeState(makeThread()), [
      makeDomainEvent("thread.turn-start-requested", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: MessageId.makeUnsafe("user-message"),
        runtimeMode: "full-access",
        dispatchMode: "queue",
        createdAt: "2026-02-27T00:05:00.000Z",
      }),
    ]);

    const next = syncServerReadModel(
      liveState,
      makeReadModel(
        makeReadModelThread({
          updatedAt: "2026-02-27T00:05:00.000Z",
          latestTurn: null,
          session: null,
        }),
      ),
    );

    expect(threadsOf(next)[0]?.updatedAt).toBe("2026-02-27T00:05:00.000Z");
    expect(threadsOf(next)[0]?.latestTurn).toBeNull();
  });

  it("does not rebuild sidebar summaries for streaming assistant deltas", () => {
    const initialState = syncServerReadModel(
      makeState(makeThread({ title: "Stable sidebar title" })),
      makeReadModel(
        makeReadModelThread({
          title: "Stable sidebar title",
          updatedAt: "2026-02-27T00:00:00.000Z",
        }),
      ),
    );

    const previousSummary = initialState.sidebarThreadSummaryById["thread-1"];
    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.message-sent", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: MessageId.makeUnsafe("assistant-streaming"),
        role: "assistant",
        text: "streaming delta",
        turnId: TurnId.makeUnsafe("turn-1"),
        streaming: true,
        createdAt: "2026-02-27T00:01:00.000Z",
        updatedAt: "2026-02-27T00:01:00.000Z",
        attachments: [],
        source: "native",
      }),
    ]);

    expect(next.sidebarThreadSummaryById["thread-1"]).toBe(previousSummary);
    expect(threadsOf(next)[0]?.messages.at(-1)).toMatchObject({
      id: MessageId.makeUnsafe("assistant-streaming"),
      text: "streaming delta",
      streaming: true,
    });
  });

  it("replaces duplicate live activities by id instead of appending duplicate ids", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const initialState = makeState(
      makeThread({
        activities: [
          makeActivity({
            id: "activity-command",
            kind: "tool.completed",
            summary: "Ran command",
            payload: { title: "Ran command" },
          }),
        ],
      }),
    );
    const richActivity = makeActivity({
      id: "activity-command",
      kind: "tool.completed",
      summary: "Ran command",
      payload: {
        itemType: "command_execution",
        title: "Ran command",
        data: {
          item: {
            type: "commandExecution",
            command: `/bin/zsh -lc "sed -n '1,220p' README.md"`,
          },
        },
      },
    });

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.activity-appended", {
        threadId,
        activity: richActivity,
      }),
    ]);

    expect(threadsOf(next)[0]?.activities).toHaveLength(1);
    expect(threadsOf(next)[0]?.activities[0]?.payload).toEqual(richActivity.payload);
    expect(next.activityIdsByThreadId?.[threadId]).toEqual(["activity-command"]);
    expect(Object.keys(next.activityByThreadId?.[threadId] ?? {})).toEqual(["activity-command"]);
  });

  it("replaces a live reasoning start with completion under its stable activity id", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const activityId = "provider-reasoning:thread-1:reasoning-1";
    const started = makeActivity({
      id: activityId,
      createdAt: "2026-02-27T00:00:01.000Z",
      kind: "task.progress",
      summary: "Reasoning trace",
      tone: "tool",
      payload: {
        status: "inProgress",
        data: { toolCallId: "reasoning-1" },
      },
      turnId: "turn-1",
    });
    const completed = makeActivity({
      id: activityId,
      createdAt: "2026-02-27T00:00:02.000Z",
      kind: "task.progress",
      summary: "Reasoning trace",
      tone: "tool",
      payload: {
        status: "completed",
        detail: "Inspecting apps/web/src/store.ts",
        data: { toolCallId: "reasoning-1" },
      },
      turnId: "turn-1",
    });

    const next = applyOrchestrationEventsHotPath(makeState(makeThread()), [
      makeDomainEvent("thread.activity-appended", { threadId, activity: started }, { sequence: 1 }),
      makeDomainEvent(
        "thread.activity-appended",
        { threadId, activity: completed },
        { sequence: 2 },
      ),
    ]);

    expect(threadsOf(next)[0]?.activities).toHaveLength(1);
    expect(threadsOf(next)[0]?.activities[0]).toMatchObject({
      id: activityId,
      sequence: 2,
      payload: {
        status: "completed",
        detail: "Inspecting apps/web/src/store.ts",
        data: { toolCallId: "reasoning-1" },
      },
    });
    expect(next.activityIdsByThreadId?.[threadId]).toEqual([activityId]);
  });

  it("batch-reduces consecutive activity events without changing the resulting state", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const events = [0, 1, 2].map((index) =>
      makeDomainEvent(
        "thread.activity-appended",
        {
          threadId,
          activity: makeActivity({
            id: `activity-batch-${index}`,
            sequence: index + 1,
            kind: "tool.updated",
            summary: `Tool update ${index}`,
            createdAt: `2026-07-09T00:00:0${index}.000Z`,
          }),
        },
        { sequence: index + 1 },
      ),
    );
    const initialState = makeState(makeThread());

    const sequential = events.reduce(
      (state, currentEvent) => applyOrchestrationEventsHotPath(state, [currentEvent]),
      initialState,
    );
    const batched = applyOrchestrationEventsHotPath(initialState, events);

    expect(threadsOf(batched)[0]?.activities).toEqual(threadsOf(sequential)[0]?.activities);
    expect(batched.activityIdsByThreadId?.[threadId]).toEqual(
      sequential.activityIdsByThreadId?.[threadId],
    );
    expect(batched.activityByThreadId?.[threadId]).toEqual(
      sequential.activityByThreadId?.[threadId],
    );
    expect(threadsOf(batched)[0]?.updatedAt).toBe("2026-07-09T00:00:02.000Z");
  });

  it("replaces provider-local activity sequences with durable orchestration sequences", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const events = [
      makeDomainEvent(
        "thread.activity-appended",
        {
          threadId,
          activity: makeActivity({ id: "activity-before-restart", sequence: 99 }),
        },
        { sequence: 40 },
      ),
      makeDomainEvent(
        "thread.activity-appended",
        {
          threadId,
          activity: makeActivity({ id: "activity-after-restart", sequence: 0 }),
        },
        { sequence: 41 },
      ),
    ];
    const initialState = makeState(makeThread());

    const sequential = events.reduce(
      (state, event) => applyOrchestrationEventsHotPath(state, [event]),
      initialState,
    );
    const batched = applyOrchestrationEventsHotPath(initialState, events);

    expect(threadsOf(sequential)[0]?.activities.map((activity) => activity.sequence)).toEqual([
      40, 41,
    ]);
    expect(threadsOf(batched)[0]?.activities.map((activity) => activity.sequence)).toEqual([
      40, 41,
    ]);
  });

  it("keeps batched activity timestamps equivalent when a generic duplicate is discarded", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const richActivity = makeActivity({
      id: "activity-command",
      kind: "tool.completed",
      summary: "Ran command",
      createdAt: "2026-07-09T00:00:00.000Z",
      payload: {
        itemType: "command_execution",
        title: "Ran command",
        detail: "echo hello",
        data: {
          item: {
            type: "commandExecution",
            command: "echo hello",
          },
        },
      },
    });
    const initialState = makeState(
      makeThread({
        updatedAt: richActivity.createdAt,
        activities: [richActivity],
      }),
    );
    const events = [
      makeDomainEvent(
        "thread.activity-appended",
        {
          threadId,
          activity: makeActivity({
            id: "activity-new",
            kind: "tool.updated",
            summary: "New activity",
            createdAt: "2026-07-09T00:00:01.000Z",
          }),
        },
        { sequence: 1 },
      ),
      makeDomainEvent(
        "thread.activity-appended",
        {
          threadId,
          activity: makeActivity({
            id: richActivity.id,
            kind: richActivity.kind,
            summary: richActivity.summary,
            createdAt: "2026-07-09T00:00:10.000Z",
            payload: { title: "Ran command" },
          }),
        },
        { sequence: 2 },
      ),
    ];

    const sequential = events.reduce(
      (state, currentEvent) => applyOrchestrationEventsHotPath(state, [currentEvent]),
      initialState,
    );
    const batched = applyOrchestrationEventsHotPath(initialState, events);

    expect(threadsOf(batched)[0]).toEqual(threadsOf(sequential)[0]);
    expect(threadsOf(batched)[0]?.updatedAt).toBe("2026-07-09T00:00:01.000Z");
  });

  it("keeps richer activity payloads when duplicate events arrive with generic data", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const richActivity = makeActivity({
      id: "activity-command",
      kind: "tool.completed",
      summary: "Ran command",
      payload: {
        itemType: "command_execution",
        title: "Ran command",
        detail: `/bin/zsh -lc "sed -n '1,220p' README.md"`,
        data: {
          item: {
            type: "commandExecution",
            command: `/bin/zsh -lc "sed -n '1,220p' README.md"`,
            commandActions: [{ type: "read", command: "sed -n '1,220p' README.md" }],
          },
        },
      },
    });
    const initialState = syncServerReadModel(
      makeState(makeThread()),
      makeReadModel(makeReadModelThread({ activities: [richActivity] })),
    );
    const genericDuplicate = makeActivity({
      id: "activity-command",
      kind: "tool.completed",
      summary: "Ran command",
      payload: { title: "Ran command" },
    });

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.activity-appended", {
        threadId,
        activity: genericDuplicate,
      }),
    ]);

    expect(threadsOf(next)[0]?.activities).toHaveLength(1);
    expect(threadsOf(next)[0]?.activities[0]).toBe(richActivity);
    expect(next.activityByThreadId?.[threadId]?.["activity-command"]).toBe(richActivity);
  });

  it("uses durable user-input settlement without fabricating a resolved activity", () => {
    const initialState = syncServerReadModel(
      makeState(
        makeThread({
          hasPendingUserInput: true,
          activities: [
            makeActivity({
              id: "activity-user-input-requested",
              createdAt: "2026-02-27T00:00:30.000Z",
              kind: "user-input.requested",
              summary: "Need more input",
              payload: {
                requestId: "request-1",
                questions: [
                  {
                    id: "q1",
                    prompt: "Pick one",
                    type: "single_select",
                    options: [{ id: "yes", label: "Yes" }],
                  },
                ],
              },
              sequence: 1,
            }),
          ],
        }),
      ),
      makeReadModel(
        makeReadModelThread({
          hasPendingUserInput: true,
          pendingInteractions: [
            {
              interactionKind: "userInput",
              requestId: ApprovalRequestId.makeUnsafe("request-1"),
              threadId: ThreadId.makeUnsafe("thread-1"),
              turnId: null,
              lifecycleGeneration: "generation-1",
              status: "pending",
              decision: null,
              responseCommandId: null,
              responseRequestedAt: null,
              createdAt: "2026-02-27T00:00:30.000Z",
              resolvedAt: null,
            },
          ],
          activities: [
            makeActivity({
              id: "activity-user-input-requested",
              createdAt: "2026-02-27T00:00:30.000Z",
              kind: "user-input.requested",
              summary: "Need more input",
              payload: {
                requestId: "request-1",
                lifecycleGeneration: "generation-1",
                questions: [
                  {
                    id: "q1",
                    prompt: "Pick one",
                    type: "single_select",
                    options: [{ id: "yes", label: "Yes" }],
                  },
                ],
              },
              sequence: 1,
            }),
          ],
        }),
      ),
    );

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent(
        "thread.user-input-response-requested",
        {
          threadId: ThreadId.makeUnsafe("thread-1"),
          requestId: ApprovalRequestId.makeUnsafe("request-1"),
          answers: {
            q1: "yes",
          },
          lifecycleGeneration: "generation-1",
          createdAt: "2026-02-27T00:01:00.000Z",
        },
        {
          commandId: CommandId.makeUnsafe("command-user-input-response"),
        },
      ),
    ]);

    expect(threadsOf(next)[0]?.hasPendingUserInput).toBe(false);
    expect(threadsOf(next)[0]?.pendingInteractions?.[0]?.status).toBe("responding");
    expect(threadsOf(next)[0]?.pendingInteractions?.[0]?.responseCommandId).toBe(
      CommandId.makeUnsafe("command-user-input-response"),
    );
    expect(
      threadsOf(next)[0]?.activities.some((activity) => activity.kind === "user-input.resolved"),
    ).toBe(false);
    expect(next.sidebarThreadSummaryById["thread-1"]?.hasPendingUserInput).toBe(false);

    const retryable = applyOrchestrationEvents(next, [
      makeDomainEvent("thread.activity-appended", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        activity: makeActivity({
          id: "activity-user-input-retryable",
          kind: "provider.user-input.respond.failed",
          payload: {
            requestId: "request-1",
            lifecycleGeneration: "generation-1",
            responseCommandId: "command-user-input-response",
            settlementStatus: "retryable",
          },
          sequence: 3,
        }),
      }),
    ]);
    expect(threadsOf(retryable)[0]?.pendingInteractions?.[0]?.status).toBe("retryable");
    expect(threadsOf(retryable)[0]?.hasPendingUserInput).toBe(true);

    const confirmed = applyOrchestrationEvents(retryable, [
      makeDomainEvent("thread.activity-appended", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        activity: makeActivity({
          id: "activity-user-input-confirmed",
          kind: "user-input.resolved",
          payload: {
            requestId: "request-1",
            lifecycleGeneration: "generation-1",
          },
          sequence: 4,
        }),
      }),
    ]);
    expect(threadsOf(confirmed)[0]?.pendingInteractions).toEqual([]);
    expect(threadsOf(confirmed)[0]?.hasPendingUserInput).toBe(false);
  });

  it("clears pending approval summary state when an approval response is requested", () => {
    const initialState = syncServerReadModel(
      makeState(
        makeThread({
          hasPendingApprovals: true,
          activities: [
            makeActivity({
              id: "activity-approval-requested",
              createdAt: "2026-02-27T00:00:30.000Z",
              kind: "approval.requested",
              summary: "Command approval requested",
              tone: "approval",
              payload: {
                requestId: "request-1",
                requestKind: "command",
              },
              sequence: 1,
            }),
          ],
        }),
      ),
      makeReadModel(
        makeReadModelThread({
          hasPendingApprovals: true,
          pendingInteractions: [
            {
              interactionKind: "approval",
              requestId: ApprovalRequestId.makeUnsafe("request-1"),
              threadId: ThreadId.makeUnsafe("thread-1"),
              turnId: null,
              lifecycleGeneration: "generation-1",
              status: "pending",
              decision: null,
              responseCommandId: null,
              responseRequestedAt: null,
              createdAt: "2026-02-27T00:00:30.000Z",
              resolvedAt: null,
            },
          ],
          activities: [
            makeActivity({
              id: "activity-approval-requested",
              createdAt: "2026-02-27T00:00:30.000Z",
              kind: "approval.requested",
              summary: "Command approval requested",
              tone: "approval",
              payload: {
                requestId: "request-1",
                lifecycleGeneration: "generation-1",
                requestKind: "command",
              },
              sequence: 1,
            }),
          ],
        }),
      ),
    );

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent(
        "thread.approval-response-requested",
        {
          threadId: ThreadId.makeUnsafe("thread-1"),
          requestId: ApprovalRequestId.makeUnsafe("request-1"),
          lifecycleGeneration: "generation-1",
          decision: "accept",
          createdAt: "2026-02-27T00:01:00.000Z",
        },
        {
          commandId: CommandId.makeUnsafe("command-approval-response"),
        },
      ),
    ]);

    expect(threadsOf(next)[0]?.hasPendingApprovals).toBe(false);
    expect(threadsOf(next)[0]?.pendingInteractions?.[0]?.status).toBe("responding");
    expect(next.sidebarThreadSummaryById["thread-1"]?.hasPendingApprovals).toBe(false);
  });

  it("updates sidebar summaries during hot-path archive events", () => {
    const initialState = syncServerReadModel(
      makeState(makeThread({ title: "Archivable thread" })),
      makeReadModel(
        makeReadModelThread({
          title: "Archivable thread",
          updatedAt: "2026-02-27T00:00:00.000Z",
        }),
      ),
    );

    const next = applyOrchestrationEventsHotPath(
      initialState,
      [
        makeDomainEvent("thread.archived", {
          threadId: ThreadId.makeUnsafe("thread-1"),
          archivedAt: "2026-02-27T00:07:00.000Z",
          updatedAt: "2026-02-27T00:07:00.000Z",
        }),
      ],
      { updateSidebarSummary: true },
    );

    expect(next.sidebarThreadSummaryById["thread-1"]?.archivedAt).toBe("2026-02-27T00:07:00.000Z");
  });

  it("removes archived threads when a delete event reaches the hot path", () => {
    const threadId = ThreadId.makeUnsafe("thread-archived");
    const initialState = syncServerReadModel(
      makeState(makeThread()),
      makeReadModel(
        makeReadModelThread({
          id: threadId,
          archivedAt: "2026-02-27T00:05:00.000Z",
        }),
      ),
    );

    const next = applyOrchestrationEventsHotPath(
      initialState,
      [
        makeDomainEvent("thread.deleted", {
          threadId,
          deletedAt: "2026-02-27T00:06:00.000Z",
        }),
      ],
      { updateSidebarSummary: true },
    );

    expect(threadsOf(next)).toHaveLength(0);
    expect(next.threadIds).not.toContain(threadId);
    expect(next.threadShellById?.[threadId]).toBeUndefined();
    expect(next.sidebarThreadSummaryById[threadId]).toBeUndefined();
    expect(next.deletedThreadIdsById?.[threadId]).toEqual(expect.any(Number));

    const afterStaleSnapshot = syncServerShellSnapshot(
      next,
      makeShellSnapshot({
        id: threadId,
        folderId: FolderId.makeUnsafe("project-1"),
        title: "Stale archived thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5.3-codex",
        },
        runtimeMode: DEFAULT_RUNTIME_MODE,
        forkSourceThreadId: null,
        latestTurn: null,
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:30.000Z",
        session: null,
      }),
    );
    expect(threadsOf(afterStaleSnapshot)).toHaveLength(0);
    expect(afterStaleSnapshot.threadShellById?.[threadId]).toBeUndefined();
  });

  it("updates sidebar summaries during hot-path thread renames", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const initialState = syncServerReadModel(
      makeState(makeThread({ title: "Original title" })),
      makeReadModel(
        makeReadModelThread({
          title: "Original title",
          updatedAt: "2026-02-27T00:00:00.000Z",
        }),
      ),
    );

    const next = applyOrchestrationEventsHotPath(
      initialState,
      [
        makeDomainEvent("thread.updated", {
          threadId,
          title: "Renamed title",
          updatedAt: "2026-02-27T00:03:00.000Z",
        }),
      ],
      { updateSidebarSummary: true },
    );

    expect(next.sidebarThreadSummaryById[threadId]).toMatchObject({
      title: "Renamed title",
      updatedAt: "2026-02-27T00:03:00.000Z",
    });
    expect(next.threadShellById?.[threadId]?.title).toBe("Renamed title");
    expect(threadsOf(next).find((thread) => thread.id === threadId)?.title).toBe("Renamed title");
  });

  it("updates sidebar summaries when a hot-path session starts running", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = TurnId.makeUnsafe("turn-running");
    const initialState = syncServerReadModel(
      makeState(makeThread()),
      makeReadModel(
        makeReadModelThread({
          updatedAt: "2026-02-27T00:00:00.000Z",
        }),
      ),
    );

    const next = applyOrchestrationEventsHotPath(
      initialState,
      [
        makeDomainEvent("thread.session-set", {
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: "2026-02-27T00:04:00.000Z",
          },
        }),
      ],
      { updateSidebarSummary: true },
    );

    expect(next.sidebarThreadSummaryById[threadId]?.session).toMatchObject({
      status: "running",
      orchestrationStatus: "running",
      activeTurnId: turnId,
    });
    expect(next.sidebarThreadSummaryById[threadId]?.latestTurn).toMatchObject({
      turnId,
      state: "running",
      completedAt: null,
    });
  });

  it("updates sidebar summaries during hot-path archive events after thread detail sync", () => {
    const shellState = syncServerReadModel(
      makeState(makeThread({ title: "Archivable thread" })),
      makeReadModel(
        makeReadModelThread({
          title: "Archivable thread",
          updatedAt: "2026-02-27T00:00:00.000Z",
        }),
      ),
    );
    const initialState = syncServerThreadDetailHotPath(
      shellState,
      makeReadModelThread({
        title: "Detail-only title",
        updatedAt: "2026-02-27T00:05:00.000Z",
      }),
    );

    const next = applyOrchestrationEventsHotPath(
      initialState,
      [
        makeDomainEvent("thread.archived", {
          threadId: ThreadId.makeUnsafe("thread-1"),
          archivedAt: "2026-02-27T00:07:00.000Z",
          updatedAt: "2026-02-27T00:07:00.000Z",
        }),
      ],
      { updateSidebarSummary: true },
    );

    expect(next.sidebarThreadSummaryById["thread-1"]?.archivedAt).toBe("2026-02-27T00:07:00.000Z");
  });

  it("preserves outer normalized records when an event is a no-op", () => {
    const state = syncServerReadModel(
      makeState(makeThread()),
      makeReadModel(makeReadModelThread({ title: "Thread" })),
    );
    const next = applyOrchestrationEvents(state, [
      makeDomainEvent("thread.updated", {
        threadId: ThreadId.makeUnsafe("missing-thread"),
        title: "Ignored",
        updatedAt: "2026-02-27T00:00:00.000Z",
      }),
    ]);

    expect(next).toBe(state);
    expect(next.threadShellById).toBe(state.threadShellById);
    expect(next.messageByThreadId).toBe(state.messageByThreadId);
    expect(next.activityByThreadId).toBe(state.activityByThreadId);
    expect(next.sidebarThreadSummaryById).toBe(state.sidebarThreadSummaryById);
  });

  it("touches only the streamed message slot and its id list stays reference-stable", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const olderIds = Array.from({ length: 5 }, (_, index) =>
      MessageId.makeUnsafe(`message-${index}`),
    );
    const streamingId = MessageId.makeUnsafe("message-streaming");
    const initialState = makeState(
      makeThread({
        messages: [
          ...olderIds.map((id, index) => ({
            id,
            role: "user" as const,
            text: `prompt ${index}`,
            turnId: null,
            createdAt: "2026-02-27T00:01:00.000Z",
            streaming: false,
            source: "native" as const,
          })),
          {
            id: streamingId,
            role: "assistant" as const,
            text: "Hello",
            turnId: null,
            createdAt: "2026-02-27T00:01:00.000Z",
            streaming: true,
            source: "native" as const,
          },
        ],
      }),
    );

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.message-sent", {
        threadId,
        messageId: streamingId,
        role: "assistant",
        text: " world",
        turnId: null,
        streaming: true,
        createdAt: "2026-02-27T00:01:00.000Z",
        updatedAt: "2026-02-27T00:01:01.000Z",
        attachments: [],
        source: "native",
      }),
    ]);

    expect(threadsOf(next)[0]?.messages.at(-1)?.text).toBe("Hello world");
    // Only the streamed message is rewritten; every untouched message keeps its identity so
    // memoized message rows do not re-render on each delta.
    for (const id of olderIds) {
      expect(next.messageByThreadId?.[threadId]?.[id]).toBe(
        initialState.messageByThreadId?.[threadId]?.[id],
      );
    }
    expect(next.messageByThreadId?.[threadId]?.[streamingId]).not.toBe(
      initialState.messageByThreadId?.[threadId]?.[streamingId],
    );
    // The id order is unchanged by an in-place update, so the id list must not be rebuilt.
    expect(next.messageIdsByThreadId?.[threadId]).toBe(
      initialState.messageIdsByThreadId?.[threadId],
    );
  });
  it("treats a skipped provider lifecycle write as state-neutral", () => {
    const initial = makeState(
      makeThread({
        session: {
          provider: "codex",
          status: "running",
          orchestrationStatus: "running",
          activeTurnId: TurnId.makeUnsafe("turn-successor"),
          createdAt: "2026-09-07T02:00:00.000Z",
          updatedAt: "2026-09-07T02:00:01.000Z",
        },
      }),
    );
    const next = applyOrchestrationEvents(initial, [
      makeDomainEvent("thread.provider-lifecycle-write-skipped", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        expectedLifecycleGeneration: "generation-a",
        observedLifecycleGeneration: "generation-b",
        mutationType: "thread.session.set",
        reason: "session-ownership-mismatch",
        expectedSessionOwnership: {
          status: "running",
          updatedAt: "2026-09-07T02:00:00.000Z",
          activeTurnId: TurnId.makeUnsafe("turn-a"),
        },
        observedSessionOwnership: {
          status: "running",
          updatedAt: "2026-09-07T02:00:00.000Z",
          activeTurnId: TurnId.makeUnsafe("turn-b"),
        },
      }),
    ]);
    expect(next).toBe(initial);
  });
});
