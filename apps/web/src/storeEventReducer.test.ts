// FILE: storeEventReducer.test.ts
// Purpose: Exercises orchestration domain-event reduction and batching.

import { createStore } from "zustand/vanilla";

import {
  EventId,
  MessageId,
  ProviderConnectionId,
  FolderId,
  ThreadId,
  TurnId,
} from "@penkra/contracts";
import { describe, expect, it } from "vitest";

import { applyOrchestrationEvents, applyOrchestrationEventsHotPath } from "./storeEventReducer";
import {
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
        model: "gpt-5-codex",
        hiddenTurnId: null,
        continueInFlight: false,
        sendBusy: false,
        connecting: false,
        hasSendableContent: false,
      }),
    ).toBe(true);
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
