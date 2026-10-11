// FILE: storeEventReducer.test.ts
// Purpose: Exercises orchestration domain-event reduction and batching.

import { createStore } from "zustand/vanilla";

import {
  ApprovalRequestId,
  CommandId,
  EventId,
  MessageId,
  ProviderConnectionId,
  FolderId,
  SpaceId,
  ThreadId,
  TurnId,
} from "@penkra/contracts";
import { describe, expect, it } from "vitest";

import { applyOrchestrationEvents, applyOrchestrationEventsHotPath } from "./storeEventReducer";
import {
  applyShellEvent,
  syncServerThreadShell,
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
  threadsOf,
} from "./storeTestFixtures";
import { DEFAULT_RUNTIME_MODE } from "./types";
import { createComposerDraftStoreState } from "./composerDraftActions";
import type { ComposerDraftStoreState } from "./composerDraftDomain";
import { resolveThreadStatusPill } from "./components/Sidebar.logic";
import { shouldShowComposerContinue } from "./components/ChatView.logic";

describe("store event reducer", () => {
  it("keeps a broadcast row when an older in-flight snapshot reply arrives", async () => {
    const oldRow = makeReadModelThread({
      title: "Older reply",
      updatedAt: "2026-02-27T00:01:00.000Z",
    });
    const initial = syncServerReadModel(makeState(makeThread()), makeReadModel(oldRow));
    let resolveReply!: (snapshot: import("@penkra/contracts").OrchestrationThreadShell) => void;
    const inFlight = new Promise<import("@penkra/contracts").OrchestrationThreadShell>(
      (resolve) => {
        resolveReply = resolve;
      },
    );
    const newRow = {
      ...oldRow,
      title: "Newer broadcast",
      updatedAt: "2026-02-27T00:02:00.000Z",
    };
    const broadcast = syncServerThreadShell(initial, oldRow.id, newRow);
    resolveReply(oldRow);
    const afterReply = syncServerThreadShell(broadcast, oldRow.id, await inFlight);
    expect(threadsOf(afterReply)[0]).toMatchObject({
      title: newRow.title,
      updatedAt: newRow.updatedAt,
    });
    expect(afterReply.sidebarThreadSummaryById[oldRow.id]?.title).toBe(newRow.title);
    expect(syncServerThreadShell(broadcast, oldRow.id, oldRow)).toBe(broadcast);
    const afterDetailReply = syncServerReadModel(broadcast, {
      ...makeReadModel(oldRow),
      snapshotSequence: 2,
    });
    expect(threadsOf(afterDetailReply)[0]?.title).toBe(newRow.title);
  });

  it("applies thread metadata immediately during live updates", () => {
    const row = makeReadModelThread({ title: "Old title" });
    const initial = syncServerReadModel(makeState(makeThread()), makeReadModel(row));
    const next = syncServerThreadShell(initial, row.id, {
      ...row,
      title: "New title",
      updatedAt: "2026-02-27T00:01:00.000Z",
    });
    expect(threadsOf(next)[0]).toMatchObject({
      title: "New title",
      updatedAt: "2026-02-27T00:01:00.000Z",
    });
    expect(next.sidebarThreadSummaryById[row.id]?.title).toBe("New title");
  });
  it("preserves a thread's null connection through unrelated canonical updates", () => {
    const row = makeReadModelThread({ connectionId: null });
    const initial = syncServerReadModel(makeState(makeThread()), makeReadModel(row));
    const next = syncServerThreadShell(initial, row.id, { ...row, title: "Renamed thread" });
    expect(threadsOf(next)[0]?.connectionId).toBeNull();
  });
  it("updates sidebar summaries when the canonical row is archived", () => {
    const row = makeReadModelThread({ title: "Archivable thread" });
    const initial = syncServerReadModel(makeState(makeThread()), makeReadModel(row));
    const at = "2026-02-27T00:07:00.000Z";
    const next = syncServerThreadShell(initial, row.id, { ...row, archivedAt: at, updatedAt: at });
    expect(next.sidebarThreadSummaryById[row.id]?.archivedAt).toBe(at);
  });
  it("removes archived threads when the canonical row is deleted", () => {
    const row = makeReadModelThread({ archivedAt: "2026-02-27T00:05:00.000Z" });
    const initial = syncServerReadModel(makeState(makeThread()), makeReadModel(row));
    const next = syncServerThreadShell(initial, row.id, null);
    expect(threadsOf(next)).toHaveLength(0);
    expect(next.threadIds).not.toContain(row.id);
    expect(next.threadShellById?.[row.id]).toBeUndefined();
    expect(next.sidebarThreadSummaryById[row.id]).toBeUndefined();
  });
  it("updates sidebar summaries during canonical renames", () => {
    const row = makeReadModelThread({ title: "Original title" });
    const initial = syncServerReadModel(makeState(makeThread()), makeReadModel(row));
    const next = syncServerThreadShell(initial, row.id, {
      ...row,
      title: "Renamed title",
      updatedAt: "2026-02-27T00:03:00.000Z",
    });
    expect(next.sidebarThreadSummaryById[row.id]).toMatchObject({
      title: "Renamed title",
      updatedAt: "2026-02-27T00:03:00.000Z",
    });
    expect(next.threadShellById?.[row.id]?.title).toBe("Renamed title");
  });
  it("updates sidebar archive summaries after thread detail sync", () => {
    const row = makeReadModelThread({ title: "Archivable thread" });
    const shell = syncServerReadModel(makeState(makeThread()), makeReadModel(row));
    const initial = syncServerThreadDetailHotPath(shell, {
      ...row,
      title: "Detail-only title",
      updatedAt: "2026-02-27T00:05:00.000Z",
    });
    const at = "2026-02-27T00:07:00.000Z";
    const next = syncServerThreadShell(initial, row.id, { ...row, archivedAt: at, updatedAt: at });
    expect(next.sidebarThreadSummaryById[row.id]?.archivedAt).toBe(at);
  });

  it("registers canonical shell rows and applies archive, restore and deletion", () => {
    const initial = makeState(makeThread());
    const rows = Array.from({ length: 6 }, (_, index) =>
      makeReadModelThread({
        id: ThreadId.makeUnsafe(`agent-worker-${index}`),
        title: `Worker ${index}`,
        creationSource: "penkra_mcp",
        sourceThreadId: ThreadId.makeUnsafe("thread-1"),
        createdAt: "2026-09-06T00:10:00.000Z",
        updatedAt: "2026-09-06T00:10:00.000Z",
      }),
    );
    const next = rows.reduce((state, row) => syncServerThreadShell(state, row.id, row), initial);
    expect(rows.filter((row) => next.threadShellById?.[row.id])).toHaveLength(6);
    for (const row of rows)
      expect(next.threadShellById?.[row.id]?.creationSource).toBe("penkra_mcp");
    const row = rows[0]!;
    const archived = syncServerThreadShell(next, row.id, {
      ...row,
      archivedAt: "2026-09-06T00:10:02.000Z",
      updatedAt: "2026-09-06T00:10:02.000Z",
    });
    expect(archived.threadShellById?.[row.id]?.archivedAt).toBe("2026-09-06T00:10:02.000Z");
    const restored = syncServerThreadShell(archived, row.id, {
      ...row,
      updatedAt: "2026-09-06T00:10:03.000Z",
    });
    expect(restored.threadShellById?.[row.id]?.archivedAt).toBeNull();
    const deleted = syncServerThreadShell(restored, row.id, null);
    expect(deleted.threadShellById?.[row.id]).toBeUndefined();
    expect(syncServerThreadShell(deleted, row.id, null)).toBe(deleted);
  });

  it("keeps a session error ahead of a live queued delivery failure", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const messageId = MessageId.makeUnsafe("queued-session-error");
    const sessionError = "Provider crashed.";
    const initial = makeState(
      makeThread({
        error: sessionError,
        session: {
          provider: "codex",
          status: "error",
          orchestrationStatus: "error",
          activeTurnId: undefined,
          lastError: sessionError,
          createdAt: "2026-09-27T00:00:00.000Z",
          updatedAt: "2026-09-27T00:00:00.000Z",
        },
        queuedMessageIds: [messageId],
        messages: [
          {
            id: messageId,
            role: "user",
            text: "Continue",
            dispatchMode: "queue",
            delivery: { state: "queued", queued: true, sequence: 10 },
            streaming: false,
            source: "native",
            sequence: 10,
            createdAt: "2026-09-27T00:00:00.000Z",
          },
        ],
      }),
    );
    const failed = threadsOf(
      applyOrchestrationEvents(initial, [
        makeDomainEvent(
          "thread.message-delivery-set",
          {
            threadId,
            messageId,
            state: "failed",
            queued: false,
            failurePhase: "before-provider-dispatch",
            failureDetail: "Choose another provider.",
            updatedAt: "2026-09-27T00:00:01.000Z",
          },
          { sequence: 11 },
        ),
      ]),
    )[0];
    expect(failed?.messages[0]?.delivery?.state).toBe("failed");
    expect(failed?.error).toBe(sessionError);
  });
  it("fails a queued promotion in place and ignores a stale failure after promotion", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const messageId = MessageId.makeUnsafe("queued-refused");
    const reason =
      "This thread uses a different provider. To use another provider, start a new thread.";
    const queued = makeState(
      makeThread({
        queuedMessageIds: [messageId],
        messages: [
          {
            id: messageId,
            role: "user",
            text: "Continue",
            dispatchMode: "queue",
            delivery: { state: "queued", queued: true, sequence: 10 },
            streaming: false,
            source: "native",
            sequence: 10,
            createdAt: "2026-09-27T00:00:00.000Z",
          },
        ],
      }),
    );
    const failure = makeDomainEvent(
      "thread.message-delivery-set",
      {
        threadId,
        messageId,
        state: "failed",
        queued: false,
        failurePhase: "before-provider-dispatch",
        failureDetail: reason,
        updatedAt: "2026-09-27T00:00:01.000Z",
      },
      { sequence: 12 },
    );
    const failed = threadsOf(applyOrchestrationEvents(queued, [failure]))[0]!;
    expect(failed.messages[0]?.delivery).toMatchObject({
      state: "failed",
      queued: false,
      failureDetail: reason,
      sequence: 12,
    });
    expect(failed.queuedMessageIds).toEqual([]);
    expect(failed.error).toBe(reason);
    expect(failed.session).toBeNull();

    const promoted = makeState(
      makeThread({
        queuedMessageIds: [],
        messages: [
          {
            id: messageId,
            role: "user",
            text: "Continue",
            dispatchMode: "queue",
            delivery: { state: "accepted", queued: false, sequence: 13 },
            streaming: false,
            source: "native",
            sequence: 10,
            createdAt: "2026-09-27T00:00:00.000Z",
          },
        ],
      }),
    );
    const stale = threadsOf(applyOrchestrationEvents(promoted, [failure]))[0]!;
    expect(stale.messages[0]?.delivery?.state).toBe("accepted");
    expect(stale.error).toBeNull();
  });

  it("restores a failed queued delivery and its reason from a read-model snapshot", () => {
    const messageId = MessageId.makeUnsafe("queued-snapshot-refused");
    const reason = "This thread's Claude conversation belongs to a different Claude account.";
    const snapshot = makeReadModel(
      makeReadModelThread({
        queuedMessageIds: [messageId],
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "claudeAgent",
          activeTurnId: TurnId.makeUnsafe("earlier-turn"),
          lastError: null,
          updatedAt: "2026-09-27T00:00:00.000Z",
        },
        messages: [
          {
            id: messageId,
            role: "user",
            text: "Continue",
            turnId: null,
            dispatchMode: "queue",
            delivery: {
              state: "failed",
              queued: false,
              sequence: 12,
              failurePhase: "before-provider-dispatch",
              failureDetail: reason,
            },
            streaming: false,
            source: "native",
            sequence: 10,
            createdAt: "2026-09-27T00:00:00.000Z",
            updatedAt: "2026-09-27T00:00:01.000Z",
          },
        ],
      }),
    );
    const restored = threadsOf(syncServerReadModel(makeState(makeThread()), snapshot))[0]!;
    expect(restored.messages[0]?.delivery?.state).toBe("failed");
    expect(restored.queuedMessageIds).toEqual([]);
    expect(restored.error).toBe(reason);
    expect(restored.session?.orchestrationStatus).toBe("running");
  });
  it.each(["assistant", "delivery"] as const)(
    "settles a provisional %s completion when the owning session is interrupted",
    (completion) => {
      const threadId = ThreadId.makeUnsafe("thread-1");
      const turnId = TurnId.makeUnsafe(`turn-${completion}-stop`);
      const messageId = MessageId.makeUnsafe(`message-${completion}-stop`);
      const startedAt = "2026-09-26T21:04:38.903Z";
      const stoppedAt = "2026-09-26T21:04:49.812Z";
      const initial = makeState(
        makeThread({
          session: {
            provider: "codex",
            status: "running",
            orchestrationStatus: "running",
            activeTurnId: turnId,
            createdAt: startedAt,
            updatedAt: startedAt,
          },
          latestTurn: {
            turnId,
            state: "running",
            requestedAt: startedAt,
            startedAt,
            completedAt: null,
            assistantMessageId: null,
          },
        }),
      );
      const completed =
        completion === "assistant"
          ? makeDomainEvent(
              "thread.message-sent",
              {
                threadId,
                messageId,
                role: "assistant",
                text: "Partial reply",
                turnId,
                streaming: false,
                source: "native",
                createdAt: startedAt,
                updatedAt: stoppedAt,
                attachments: [],
              },
              { sequence: 1 },
            )
          : makeDomainEvent(
              "thread.message-delivery-set",
              {
                threadId,
                messageId,
                turnId,
                state: "accepted",
                terminalState: "completed",
                terminalCompletedAt: stoppedAt,
                updatedAt: stoppedAt,
              },
              { sequence: 1 },
            );
      const interrupted = makeDomainEvent(
        "thread.session-set",
        {
          threadId,
          session: {
            threadId,
            status: "interrupted",
            providerName: "codex",
            activeTurnId: null,
            lastError: null,
            updatedAt: stoppedAt,
          },
        },
        { sequence: 2 },
      );
      const after = applyOrchestrationEvents(initial, [completed, interrupted]);
      expect(threadsOf(after)[0]?.latestTurn?.state).toBe("interrupted");
      const ready = applyOrchestrationEvents(
        makeState(
          makeThread({
            ...threadsOf(initial)[0],
            session: {
              ...threadsOf(initial)[0]!.session!,
              status: "ready",
              orchestrationStatus: "ready",
              activeTurnId: undefined,
            },
            latestTurn: {
              ...threadsOf(initial)[0]!.latestTurn!,
              state: "completed",
              completedAt: stoppedAt,
            },
          }),
        ),
        [interrupted],
      );
      expect(threadsOf(ready)[0]?.latestTurn?.state).toBe("completed");
      const retainedActiveTurn = makeDomainEvent(
        "thread.session-set",
        {
          threadId,
          session: { ...interrupted.payload.session, activeTurnId: turnId },
        },
        { sequence: 2 },
      );
      expect(
        threadsOf(applyOrchestrationEvents(initial, [completed, retainedActiveTurn]))[0]?.latestTurn
          ?.state,
      ).toBe("completed");
    },
  );

  it("keeps an interrupted turn interrupted when the assistant completion arrives later", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = TurnId.makeUnsafe("reverse-order-stop");
    const startedAt = "2026-09-26T21:04:38.903Z";
    const initial = makeState(
      makeThread({
        session: {
          provider: "codex",
          status: "running",
          orchestrationStatus: "running",
          activeTurnId: turnId,
          createdAt: startedAt,
          updatedAt: startedAt,
        },
        latestTurn: {
          turnId,
          state: "running",
          requestedAt: startedAt,
          startedAt,
          completedAt: null,
          assistantMessageId: null,
        },
      }),
    );
    const events = [
      makeDomainEvent(
        "thread.session-set",
        {
          threadId,
          session: {
            threadId,
            status: "interrupted",
            providerName: "codex",
            activeTurnId: null,
            lastError: null,
            updatedAt: startedAt,
          },
        },
        { sequence: 1 },
      ),
      makeDomainEvent(
        "thread.message-sent",
        {
          threadId,
          messageId: MessageId.makeUnsafe("reverse-order-assistant"),
          role: "assistant",
          text: "Partial",
          turnId,
          streaming: false,
          source: "native",
          createdAt: startedAt,
          updatedAt: startedAt,
          attachments: [],
        },
        { sequence: 2 },
      ),
    ];
    expect(threadsOf(applyOrchestrationEvents(initial, events))[0]?.latestTurn?.state).toBe(
      "interrupted",
    );
  });
  it("keeps agent sender metadata and clears it on a user-origin resend", () => {
    const threadId = ThreadId.makeUnsafe("thread-agent-message-edit");
    const messageId = MessageId.makeUnsafe("message-agent-message-edit");
    const senderThreadId = ThreadId.makeUnsafe("source-agent-thread");
    const createdAt = "2026-09-26T12:00:00.000Z";
    const original = makeDomainEvent(
      "thread.message-sent",
      {
        threadId,
        messageId,
        role: "user",
        text: "original agent prompt",
        dispatchOrigin: "agent",
        senderThreadId,
        turnId: null,
        streaming: false,
        source: "native",
        createdAt,
        updatedAt: createdAt,
        attachments: [],
      },
      { sequence: 1 },
    );
    const agentState = applyOrchestrationEvents(makeState(makeThread({ id: threadId })), [
      original,
    ]);
    expect(threadsOf(agentState)[0]?.messages[0]?.senderThreadId).toBe(senderThreadId);

    const edited = makeDomainEvent(
      "thread.message-sent",
      {
        threadId,
        messageId,
        role: "user",
        text: "edited by user",
        dispatchOrigin: "user",
        turnId: null,
        streaming: false,
        source: "native",
        createdAt,
        updatedAt: createdAt,
        attachments: [],
      },
      { sequence: 2 },
    );
    const editedState = applyOrchestrationEvents(agentState, [edited]);
    expect(threadsOf(editedState)[0]?.messages[0]).toMatchObject({
      text: "edited by user",
      dispatchOrigin: "user",
    });
    expect(threadsOf(editedState)[0]?.messages[0]?.senderThreadId).toBeUndefined();
  });

  it("keeps two subscribed renderer projections converged on queued turns and thread selection", () => {
    const threadId = ThreadId.makeUnsafe("thread-shared-queue");
    const messageId = MessageId.makeUnsafe("message-shared-queue");
    const initial = makeState(
      makeThread({
        id: threadId,
        modelSelection: { provider: "opencode", model: "openai/gpt-5.5" },
      }),
    );
    const admittedEvents = [
      makeDomainEvent(
        "thread.message-sent",
        {
          threadId,
          messageId,
          role: "user",
          text: "shared queued prompt",
          attachments: [],
          dispatchMode: "queue",
          delivery: { state: "queued", queued: true },
          turnId: null,
          streaming: false,
          source: "native",
          createdAt: "2026-09-26T12:00:00.000Z",
          updatedAt: "2026-09-26T12:00:00.000Z",
        },
        { sequence: 1 },
      ),
      makeDomainEvent(
        "thread.turn-queued",
        {
          threadId,
          messageId,
          turnId: TurnId.makeUnsafe("turn-shared-queue"),
          dispatchMode: "queue",
          runtimeMode: "full-access",
          createdAt: "2026-09-26T12:00:00.000Z",
        },
        { sequence: 2 },
      ),
      makeDomainEvent(
        "thread.message-sent",
        {
          threadId,
          messageId,
          role: "user",
          text: "edited shared queued prompt",
          attachments: [],
          dispatchMode: "queue",
          delivery: { state: "queued", queued: true },
          turnId: null,
          streaming: false,
          source: "native",
          createdAt: "2026-09-26T12:00:00.000Z",
          updatedAt: "2026-09-26T12:00:03.000Z",
        },
        { sequence: 4 },
      ),
      makeDomainEvent(
        "thread.turn-start-cancelled",
        {
          threadId,
          messageId,
          turnId: TurnId.makeUnsafe("turn-shared-queue"),
          cancelledAt: "2026-09-26T12:00:02.000Z",
        },
        { sequence: 6 },
      ),
    ];

    const rendererA = createStore<AppState>(() => initial);
    const rendererB = createStore<AppState>(() => initial);
    rendererA.setState((state) =>
      syncServerThreadShell(
        applyOrchestrationEvents(state, admittedEvents.slice(0, 3)),
        threadId,
        makeReadModelThread({
          id: threadId,
          modelSelection: { provider: "opencode", model: "openai/gpt-5.6" },
          connectionId: ProviderConnectionId.makeUnsafe("connection-shared"),
          updatedAt: "2026-09-26T12:00:03.000Z",
        }),
      ),
    );
    rendererB.setState((state) =>
      syncServerThreadShell(
        applyOrchestrationEvents(state, admittedEvents.slice(0, 3)),
        threadId,
        makeReadModelThread({
          id: threadId,
          modelSelection: { provider: "opencode", model: "openai/gpt-5.6" },
          connectionId: ProviderConnectionId.makeUnsafe("connection-shared"),
          updatedAt: "2026-09-26T12:00:03.000Z",
        }),
      ),
    );
    const localDraftA = createStore<ComposerDraftStoreState>(
      createComposerDraftStoreState(() => {}),
    );
    const localDraftB = createStore<ComposerDraftStoreState>(
      createComposerDraftStoreState(() => {}),
    );
    localDraftA.getState().setPrompt(threadId, "window A unsent text");
    localDraftB.getState().setPrompt(threadId, "window B unsent text");

    const threadA = threadsOf(rendererA.getState())[0]!;
    const threadB = threadsOf(rendererB.getState())[0]!;
    expect(threadA.queuedMessageIds).toEqual([messageId]);
    expect(threadB.messages).toEqual(threadA.messages);
    expect(threadA.messages[0]?.text).toBe("edited shared queued prompt");
    expect(threadA.modelSelection).toEqual({ provider: "opencode", model: "openai/gpt-5.6" });
    expect(threadB.modelSelection).toEqual(threadA.modelSelection);
    expect(threadA.connectionId).toBe("connection-shared");
    expect(threadB.connectionId).toBe(threadA.connectionId);

    // Reconnect snapshot resync catches a renderer that missed the last event.
    rendererB.setState((state) =>
      syncServerReadModel(state, {
        ...makeReadModel(
          makeReadModelThread({
            id: threadId,
            modelSelection: { provider: "opencode", model: "openai/gpt-5.6" },
            connectionId: ProviderConnectionId.makeUnsafe("connection-shared"),
            messages: [
              {
                id: messageId,
                role: "user",
                text: "edited shared queued prompt",
                attachments: [],
                dispatchMode: "queue",
                delivery: { state: "queued", queued: true, sequence: 4 },
                turnId: null,
                streaming: false,
                source: "native",
                createdAt: "2026-09-26T12:00:00.000Z",
                updatedAt: "2026-09-26T12:00:03.000Z",
              },
            ],
          }),
        ),
        snapshotSequence: 5,
      }),
    );
    expect(threadsOf(rendererB.getState())[0]?.messages.map((message) => message.id)).toEqual(
      threadA.messages.map((message) => message.id),
    );
    expect(threadsOf(rendererB.getState())[0]?.modelSelection).toEqual(threadA.modelSelection);
    expect(threadsOf(rendererB.getState())[0]?.connectionId).toEqual(threadA.connectionId);
    expect(localDraftA.getState().draftsByThreadId[threadId]?.prompt).toBe("window A unsent text");
    expect(localDraftB.getState().draftsByThreadId[threadId]?.prompt).toBe("window B unsent text");

    rendererA.setState((state) => applyOrchestrationEvents(state, [admittedEvents[3]!]));
    rendererB.setState((state) => applyOrchestrationEvents(state, [admittedEvents[3]!]));
    expect(threadsOf(rendererA.getState())[0]?.queuedMessageIds).toEqual([]);
    expect(threadsOf(rendererB.getState())[0]?.queuedMessageIds).toEqual([]);
    expect(threadsOf(rendererB.getState())[0]?.messages).toEqual(
      threadsOf(rendererA.getState())[0]?.messages,
    );
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
    // The domain event carries no complete row; restoration arrives as a shell broadcast.
    state = applyShellEvent(state, {
      kind: "space-upserted",
      sequence: 4,
      space: {
        id: spaceId,
        name: "Restored Work",
        icon: "bag",
        sortOrder: 0,
        createdAt: "2026-07-15T10:00:00.000Z",
        updatedAt: "2026-07-15T10:00:01.200Z",
        archivedAt: null,
      },
    });
    expect(state.spaces[0]).toMatchObject({ id: spaceId, name: "Restored Work", icon: "bag" });

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
    expect(threadsOf(steering)[0]?.messages[0]?.dispatchMode).toBe("steer");

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
    expect(threadsOf(requeued)[0]?.messages[0]?.delivery).not.toHaveProperty("failurePhase");
    expect(threadsOf(requeued)[0]?.messages[0]?.delivery).not.toHaveProperty("failureDetail");
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
    const retried = threadsOf(
      applyOrchestrationEvents(failedState, [
        makeDomainEvent(
          "thread.message-delivery-set",
          {
            threadId,
            messageId,
            turnId,
            state: "starting",
            updatedAt: "2026-09-07T01:00:01.500Z",
          },
          { sequence: 13 },
        ),
      ]),
    )[0];
    expect(retried?.messages[0]?.delivery).toEqual({
      state: "starting",
      queued: false,
      sequence: 13,
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

    const deleted = (() => {
      let next = cancelled;
      next = syncServerThreadShell(next, threadId, null);
      return next;
    })();
    expect(deleted.pendingStartCancellationByThreadId).toEqual({});
  });

  it("settles cancellation ownership by exact thread and message identity", () => {
    const firstThreadId = ThreadId.makeUnsafe("thread-shared-message-first");
    const secondThreadId = ThreadId.makeUnsafe("thread-shared-message-second");
    const sharedMessageId = MessageId.makeUnsafe("message-shared-across-threads");
    const initial = (() => {
      let next = makeState(makeThread({ id: firstThreadId }));
      next = syncServerThreadShell(
        next,
        secondThreadId,
        makeReadModelThread({
          folderId: FolderId.makeUnsafe("project-1"),
          title: "Second thread",
          modelSelection: { provider: "codex", model: "gpt-5.6-sol" },
          creationSource: null,
          sourceThreadId: null,
          subagentAgentId: null,
          subagentNickname: null,
          subagentRole: null,
          createdAt: "2026-09-07T00:00:00.000Z",
          updatedAt: "2026-09-07T00:00:00.000Z",
          id: secondThreadId,
        }),
      );
      return next;
    })();
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
    const firstDeleted = (() => {
      let next = cancelled;
      next = syncServerThreadShell(next, firstThreadId, null);
      return next;
    })();
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

        folders: [],

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

        folders: [],

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

        folders: [makeProject({ id: FolderId.makeUnsafe("project-live") })],

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

  it("shows Play when an assistant completion precedes the user Stop terminal session", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = TurnId.makeUnsafe("turn-stopped-after-assistant-completion");
    const assistantMessageId = MessageId.makeUnsafe("assistant-stopped-after-completion");
    const startedAt = "2026-09-26T21:04:38.903Z";
    const completedAt = "2026-09-26T21:04:49.812Z";
    const initial = makeState(
      makeThread({
        session: {
          provider: "codex",
          status: "running",
          orchestrationStatus: "running",
          activeTurnId: turnId,
          createdAt: startedAt,
          updatedAt: startedAt,
        },
        latestTurn: {
          turnId,
          state: "running",
          requestedAt: startedAt,
          startedAt,
          completedAt: null,
          assistantMessageId: null,
        },
      }),
    );
    const afterStop = applyOrchestrationEvents(initial, [
      makeDomainEvent(
        "thread.turn-interrupt-requested",
        {
          threadId,
          turnId,
          createdAt: "2026-09-26T21:04:49.789Z",
        },
        { sequence: 1 },
      ),
      makeDomainEvent(
        "thread.message-sent",
        {
          threadId,
          messageId: assistantMessageId,
          role: "assistant",
          text: "Partial reply",
          turnId,
          streaming: false,
          source: "native",
          createdAt: startedAt,
          updatedAt: completedAt,
          attachments: [],
        },
        { sequence: 2 },
      ),
      makeDomainEvent(
        "thread.session-set",
        {
          threadId,
          session: {
            threadId,
            status: "interrupted",
            providerName: "codex",
            activeTurnId: null,
            lastError: null,
            updatedAt: completedAt,
          },
        },
        { sequence: 3 },
      ),
    ]);
    const thread = threadsOf(afterStop)[0]!;
    expect(thread.latestTurn).toMatchObject({ turnId, state: "interrupted", completedAt });
    expect(
      shouldShowComposerContinue({
        thread,
        isServerThread: true,
        hydration: "ready",
        binding: { modelId: "gpt-5-codex" },
        hiddenTurnId: null,
        continueInFlight: false,
        sendBusy: false,
        sendPreflight: false,
        connecting: false,
        hasSendableContent: false,
      }),
    ).toBe(true);
  });

  it("keeps the logical turn ID after a tool outlives two Stop requests", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = TurnId.makeUnsafe("turn:5e4001b7-a59c-42de-b1dd-20e7d27640be");
    const providerTurnId = TurnId.makeUnsafe("a3f9d56b-1701-49a9-9787-d529072d9b5f");
    const messageId = MessageId.makeUnsafe("a810f055-436d-49ad-a1bf-96d4519798de");
    const requestedAt = "2026-09-26T22:18:03.115Z";
    const runningAt = "2026-09-26T22:18:03.790Z";
    const stoppedAt = "2026-09-26T22:18:15.938Z";
    const initial = makeState(
      makeThread({
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn:previous"),
          state: "completed",
          requestedAt: "2026-09-26T22:17:35.707Z",
          startedAt: "2026-09-26T22:17:37.133Z",
          completedAt: "2026-09-26T22:17:42.559Z",
          assistantMessageId: null,
        },
        session: {
          provider: "claudeAgent",
          status: "ready",
          orchestrationStatus: "ready",
          activeTurnId: undefined,
          createdAt: "2026-09-26T22:17:42.559Z",
          updatedAt: "2026-09-26T22:17:42.559Z",
        },
      }),
    );
    const session = (
      status: "running" | "interrupted",
      activeTurnId: TurnId | null,
      updatedAt: string,
    ) =>
      makeDomainEvent("thread.session-set", {
        threadId,
        session: {
          threadId,
          status,
          providerName: "claudeAgent",
          activeTurnId,
          lastError: null,
          updatedAt,
        },
      });
    const activity = (kind: string, at: string) =>
      makeDomainEvent("thread.activity-appended", {
        threadId,
        activity: {
          id: EventId.makeUnsafe(`activity-${kind}-${at}`),
          kind,
          tone: "info",
          summary: kind,
          payload: {},
          turnId: providerTurnId,
          createdAt: at,
        },
      });
    const next = applyOrchestrationEvents(initial, [
      makeDomainEvent(
        "thread.message-sent",
        {
          threadId,
          messageId,
          role: "user",
          text: "Run a long tool",
          turnId,
          streaming: false,
          source: "native",
          createdAt: requestedAt,
          updatedAt: requestedAt,
          attachments: [],
        },
        { sequence: 559913 },
      ),
      makeDomainEvent(
        "thread.turn-start-requested",
        {
          threadId,
          turnId,
          messageId,
          runtimeMode: "full-access",
          dispatchMode: "queue",
          createdAt: requestedAt,
        },
        { sequence: 559914 },
      ),
      makeDomainEvent(
        "thread.message-delivery-set",
        { threadId, messageId, turnId, state: "accepted", updatedAt: runningAt },
        { sequence: 559915 },
      ),
      { ...session("running", providerTurnId, runningAt), sequence: 559916 },
      { ...session("running", providerTurnId, runningAt), sequence: 559917 },
      { ...activity("tool.started", "2026-09-26T22:18:04.000Z"), sequence: 559919 },
      makeDomainEvent(
        "thread.turn-interrupt-requested",
        { threadId, turnId, createdAt: "2026-09-26T22:18:06.813Z" },
        { sequence: 559921 },
      ),
      makeDomainEvent(
        "thread.turn-interrupt-requested",
        { threadId, turnId, createdAt: "2026-09-26T22:18:10.063Z" },
        { sequence: 559922 },
      ),
      { ...activity("tool.completed", "2026-09-26T22:18:15.800Z"), sequence: 559924 },
      { ...session("interrupted", null, stoppedAt), sequence: 559926 },
      { ...activity("turn.completed", stoppedAt), sequence: 559927 },
    ]);
    const thread = threadsOf(next)[0]!;
    expect(thread.latestTurn).toMatchObject({ turnId, providerTurnId, state: "interrupted" });
    expect(
      shouldShowComposerContinue({
        thread,
        isServerThread: true,
        hydration: "ready",
        binding: { modelId: "claude-haiku-4-5-20251001" },
        hiddenTurnId: null,
        continueInFlight: false,
        sendBusy: false,
        sendPreflight: false,
        connecting: false,
        hasSendableContent: false,
      }),
    ).toBe(true);
  });

  it("adopts runtime mode from user-dispatched turns", () => {
    const initialState = makeState(makeThread({}));

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

    expect(threadsOf(next)[0]).not.toHaveProperty("runtimeMode");
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

  it("marks an approval interaction responding when its response is requested", () => {
    const initialState = syncServerReadModel(
      makeState(
        makeThread({
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

    expect(threadsOf(next)[0]?.pendingInteractions?.[0]?.status).toBe("responding");
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

  it("preserves outer normalized records when an event is a no-op", () => {
    const state = syncServerReadModel(
      makeState(makeThread()),
      makeReadModel(makeReadModelThread({ title: "Thread" })),
    );
    const next = syncServerThreadShell(state, ThreadId.makeUnsafe("missing-thread"), null);

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
