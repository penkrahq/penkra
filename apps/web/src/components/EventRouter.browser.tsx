import "../index.css";

import {
  EventId,
  FolderId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  SpaceId,
  ThreadId,
  TurnId,
  singletonThreadDeckId,
  type OrchestrationEvent,
  type OrchestrationGetThreadTurnsPageResult,
  type OrchestrationReadModel,
  type OrchestrationSyncStreamItem,
  type OrchestrationThread,
  type ModelSelection,
  type ServerConfig,
  type WsWelcomePayload,
  WS_METHODS,
} from "@penkra/contracts";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { HttpResponse, http, ws } from "msw";
import { setupWorker } from "msw/browser";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useComposerDraftStore } from "../composerDraftStore";
import {
  getChatLifecycleDiagnosticSamples,
  getPersistedChatSyncIncidents,
  resetChatLifecycleDiagnostics,
} from "../chatLifecycleDiagnostics";
import { getRouter } from "../router";
import { useStore } from "../store";
import { initialState } from "../storeState";
import {
  createShellSnapshotFromReadModel,
  flattenEffectRpcRequestPayload,
  readEffectRpcClientMessage,
  sendEffectRpcChunk,
  sendEffectRpcExit,
  type EffectRpcWebSocketClient,
} from "../test/effectRpcWebSocketMock";
import { createBrowserTestServerConfig, createFullscreenTestHost } from "../test/browserHarness";
import { getThreadFromState } from "../threadDerivation";
import { makeActivity } from "../storeTestFixtures";
import { useWorkspacePathsStore } from "../workspacePathsStore";
import { resetWsNativeApiForTest } from "../wsNativeApi";

const THREAD_ID = ThreadId.makeUnsafe("thread-root-browser-test");
const OTHER_THREAD_ID = ThreadId.makeUnsafe("thread-other-browser-test");
const PROJECT_ID = FolderId.makeUnsafe("project-root-browser-test");
const TEST_SPACE_ID = SpaceId.makeUnsafe("space-root-browser-test");
const NOW_ISO = "2026-03-04T12:00:00.000Z";
const PROVIDER_RECOVERY_CASES: ReadonlyArray<[string, ModelSelection]> = [
  ["Codex", { provider: "codex", model: "gpt-5" }],
  ["Claude", { provider: "claudeAgent", model: "sonnet" }],
  ["OpenCode", { provider: "opencode", model: "openrouter/gpt-oss-120b:free" }],
];

interface TestFixture {
  snapshot: OrchestrationReadModel;
  serverConfig: ServerConfig;
  welcome: WsWelcomePayload;
}

interface AcknowledgementObservation {
  deliveryId: string;
  appliedSequence: number;
  rootTitle: string | null;
  rootMessageTexts: string[];
  rootDetailSync: string | null;
}

let fixture: TestFixture;
let activePageThreadIds: ThreadId[] = [];
let subscribeSyncRequestCount = 0;
let syncStreamRequestId: string | null = null;
let syncStreamClient: EffectRpcWebSocketClient | null = null;
let domainStreamRequestCount = 0;
let getThreadTurnsPageRequests: ThreadId[] = [];
let holdThreadTurnsPageRequests = false;
let heldThreadTurnsPageExits: Array<() => void> = [];
let acknowledgementObservations: AcknowledgementObservation[] = [];
let holdSyncAcknowledgements = false;
let heldSyncAcknowledgementExits: Array<() => void> = [];

const wsLink = ws.link(/ws(s)?:\/\/.*/);

function createThread(input: {
  id: ThreadId;
  title: string;
  messageId: string;
  messageText: string;
}): OrchestrationThread {
  return {
    id: input.id,
    deckId: singletonThreadDeckId(input.id),
    deckSortOrder: 0,
    folderId: PROJECT_ID,
    title: input.title,
    modelSelection: { provider: "codex", model: "gpt-5" },
    runtimeMode: "full-access",
    latestTurn: null,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    deletedAt: null,
    messages: [
      {
        id: MessageId.makeUnsafe(input.messageId),
        role: "user",
        text: input.messageText,
        turnId: null,
        streaming: false,
        source: "native",
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      },
    ],
    activities: [],
    pendingInteractions: [],
    session: {
      threadId: input.id,
      status: "ready",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: NOW_ISO,
    },
  };
}

function createSnapshot(): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    spaces: [],
    folders: [
      {
        id: PROJECT_ID,
        spaceId: TEST_SPACE_ID,
        title: "Project",
        workspaceRoot: "/repo/project",
        defaultModelSelection: { provider: "codex", model: "gpt-5" },
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
    decks: [THREAD_ID, OTHER_THREAD_ID].map((threadId) => ({
      id: singletonThreadDeckId(threadId),
      spaceId: TEST_SPACE_ID,
      threadIds: [threadId],
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    })),
    threads: [
      createThread({
        id: THREAD_ID,
        title: "Root test thread",
        messageId: "msg-root-user-1",
        messageText: "root message",
      }),
      createThread({
        id: OTHER_THREAD_ID,
        title: "Other test thread",
        messageId: "msg-other-user-1",
        messageText: "other message",
      }),
    ],
    updatedAt: NOW_ISO,
  };
}

function buildFixture(): TestFixture {
  return {
    snapshot: createSnapshot(),
    serverConfig: createBrowserTestServerConfig(NOW_ISO),
    welcome: {
      cwd: "/repo/project",
      projectName: "Project",
      bootstrapFolderId: PROJECT_ID,
      bootstrapThreadId: THREAD_ID,
    },
  };
}

function getFixtureThread(threadId: ThreadId): OrchestrationThread {
  const thread = fixture.snapshot.threads.find((entry) => entry.id === threadId);
  if (!thread) throw new Error(`Missing fixture thread ${threadId}`);
  return thread;
}

function createThreadTurnsPage(threadId: ThreadId): OrchestrationGetThreadTurnsPageResult {
  const thread = getFixtureThread(threadId);
  return {
    threadId,
    snapshotSequence: fixture.snapshot.snapshotSequence,
    conversationTurnCount: thread.messages.filter((message) => message.role === "user").length,
    messages: [...thread.messages],
    activities: [...thread.activities],
    pendingInteractions: [],
    hasOlder: false,
    nextCursor: null,
  };
}

function initialSyncDelivery(): OrchestrationSyncStreamItem {
  return {
    kind: "snapshot",
    deliveryId: "sync-snapshot-1",
    snapshot: {
      snapshotSequence: fixture.snapshot.snapshotSequence,
      shell: createShellSnapshotFromReadModel(fixture.snapshot),
      activeThreadPages: activePageThreadIds.map(createThreadTurnsPage),
    },
  };
}

function observeAcknowledgement(requestBody: Record<string, unknown>): void {
  const rootThread = getThreadFromState(useStore.getState(), THREAD_ID);
  acknowledgementObservations.push({
    deliveryId: String(requestBody.deliveryId),
    appliedSequence: Number(requestBody.appliedSequence),
    rootTitle: rootThread?.title ?? null,
    rootMessageTexts: rootThread?.messages.map((message) => message.text) ?? [],
    rootDetailSync: useStore.getState().threadDetailSyncById?.[THREAD_ID] ?? null,
  });
}

function resolveUnaryRequest(method: string): unknown {
  if (method === ORCHESTRATION_WS_METHODS.dispatchCommand) {
    return { sequence: fixture.snapshot.snapshotSequence + 1 };
  }
  if (method === WS_METHODS.serverGetConfig) return fixture.serverConfig;
  if (method === WS_METHODS.projectsListDevServers) return { servers: [] };
  if (method === WS_METHODS.projectsSearchEntries) return { entries: [], truncated: false };
  return {};
}

const worker = setupWorker(
  wsLink.addEventListener("connection", ({ client }) => {
    client.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const parsed = readEffectRpcClientMessage(client, event.data);
      if (parsed.kind !== "request") return;

      const request = parsed.request;
      const requestBody = flattenEffectRpcRequestPayload(request.tag, request.payload);
      const method = requestBody._tag;

      if (method === ORCHESTRATION_WS_METHODS.subscribeSync) {
        subscribeSyncRequestCount += 1;
        syncStreamRequestId = request.id;
        syncStreamClient = client;
        sendEffectRpcChunk(client, request.id, initialSyncDelivery());
        return;
      }
      if (method === ORCHESTRATION_WS_METHODS.getThreadTurnsPage) {
        const threadId = requestBody.threadId as ThreadId;
        getThreadTurnsPageRequests.push(threadId);
        const respond = () =>
          sendEffectRpcExit(client, request.id, createThreadTurnsPage(threadId));
        if (holdThreadTurnsPageRequests) {
          heldThreadTurnsPageExits.push(respond);
        } else {
          respond();
        }
        return;
      }
      if (method === ORCHESTRATION_WS_METHODS.acknowledgeSync) {
        observeAcknowledgement(requestBody);
        const respond = () => sendEffectRpcExit(client, request.id, null);
        if (holdSyncAcknowledgements) {
          heldSyncAcknowledgementExits.push(respond);
        } else {
          respond();
        }
        return;
      }
      if (method === WS_METHODS.subscribeServerLifecycle) {
        sendEffectRpcChunk(client, request.id, { type: "welcome", payload: fixture.welcome });
        return;
      }
      if (method === WS_METHODS.subscribeServerConfig) {
        sendEffectRpcChunk(client, request.id, { type: "snapshot", config: fixture.serverConfig });
        return;
      }
      if (
        method === WS_METHODS.subscribeServerProviderStatuses ||
        method === WS_METHODS.subscribeServerSettings ||
        method === WS_METHODS.subscribeTerminalEvents ||
        method === WS_METHODS.subscribeProjectDevServerEvents ||
        method === WS_METHODS.subscribeProjectWorkspaceChanges
      ) {
        return;
      }
      if (method === WS_METHODS.subscribeOrchestrationDomainEvents) {
        domainStreamRequestCount += 1;
        return;
      }
      sendEffectRpcExit(client, request.id, resolveUnaryRequest(method));
    });
  }),
  http.get("*/attachments/:attachmentId", () => new HttpResponse(null, { status: 204 })),
  http.get("*/api/project-favicon", () => new HttpResponse(null, { status: 204 })),
);

async function mountApp(routeThreadId: ThreadId = THREAD_ID) {
  const host = createFullscreenTestHost();
  const router = getRouter(createMemoryHistory({ initialEntries: [`/${routeThreadId}`] }));
  await router.load();
  const screen = await render(<RouterProvider router={router} />, { container: host });
  let cleanedUp = false;

  return {
    router,
    cleanup: async () => {
      if (cleanedUp) return;
      cleanedUp = true;
      await screen.unmount();
      if (host.isConnected) host.remove();
    },
  };
}

function sendSyncDelivery(item: OrchestrationSyncStreamItem): void {
  if (!syncStreamClient || !syncStreamRequestId) {
    throw new Error("Uniform sync stream is not connected");
  }
  sendEffectRpcChunk(syncStreamClient, syncStreamRequestId, item);
}

function createThreadUpdatedEvent(input: {
  sequence: number;
  title: string;
  occurredAt: string;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.makeUnsafe(`event-thread-updated-${input.sequence}`),
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    type: "thread.updated",
    payload: {
      threadId: THREAD_ID,
      title: input.title,
      updatedAt: input.occurredAt,
    },
    occurredAt: input.occurredAt,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
  };
}

function createThreadActivityReadModelEvent(input: {
  sequence: number;
  threadId: ThreadId;
}): OrchestrationEvent {
  const occurredAt = new Date(Date.parse(NOW_ISO) + input.sequence * 1_000).toISOString();
  return {
    sequence: input.sequence,
    eventId: EventId.makeUnsafe(`event-thread-activity-read-model-${input.sequence}`),
    aggregateKind: "thread",
    aggregateId: input.threadId,
    type: "thread.activity-read-model-updated",
    payload: {
      threadId: input.threadId,
      turnId: TurnId.makeUnsafe(`turn-canonical-operation-${input.sequence}`),
      activity: makeActivity({
        id: `operation-${input.sequence}`,
        turnId: TurnId.makeUnsafe(`turn-canonical-operation-${input.sequence}`),
        createdAt: occurredAt,
        kind: "tool.completed",
        summary: `Canonical tool output ${input.sequence}`,
        payload: {
          operationId: `operation-${input.sequence}`,
          itemType: "command_execution",
          detail: `canonical chunk ${input.sequence}`,
        },
      }),
      updatedAt: occurredAt,
    },
    occurredAt,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
  };
}

describe("EventRouter uniform orchestration sync", () => {
  beforeAll(async () => {
    fixture = buildFixture();
    await worker.start({
      onUnhandledRequest: "bypass",
      quiet: true,
      serviceWorker: { url: "/mockServiceWorker.js" },
    });
  });

  afterAll(async () => {
    await resetWsNativeApiForTest();
    await worker.stop();
  });

  beforeEach(async () => {
    await resetWsNativeApiForTest();
    fixture = buildFixture();
    activePageThreadIds = [];
    subscribeSyncRequestCount = 0;
    syncStreamRequestId = null;
    syncStreamClient = null;
    domainStreamRequestCount = 0;
    getThreadTurnsPageRequests = [];
    holdThreadTurnsPageRequests = false;
    for (const respond of heldThreadTurnsPageExits.splice(0)) respond();
    acknowledgementObservations = [];
    holdSyncAcknowledgements = false;
    for (const respond of heldSyncAcknowledgementExits.splice(0)) respond();
    document.body.innerHTML = "";
    localStorage.clear();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    resetChatLifecycleDiagnostics();
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByFolderId: {},
    });
    useStore.setState({ ...initialState });
    useWorkspacePathsStore.setState({ homeDir: null, chatWorkspaceRoot: null });
  });

  afterEach(async () => {
    await resetWsNativeApiForTest();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("subscribes once and hydrates the initial shell plus included active page", async () => {
    activePageThreadIds = [THREAD_ID];
    const mounted = await mountApp();

    try {
      await vi.waitFor(() => {
        expect(acknowledgementObservations).toHaveLength(1);
        expect(useStore.getState().threadDetailSyncById?.[THREAD_ID]).toBe("synced");
      });

      expect(subscribeSyncRequestCount).toBe(1);
      expect(getThreadTurnsPageRequests).toEqual([]);
      expect(getThreadFromState(useStore.getState(), THREAD_ID)).toMatchObject({
        title: "Root test thread",
        messages: [{ text: "root message" }],
      });
      expect(acknowledgementObservations).toEqual([
        {
          deliveryId: "sync-snapshot-1",
          appliedSequence: 1,
          rootTitle: "Root test thread",
          rootMessageTexts: ["root message"],
          rootDetailSync: "synced",
        },
      ]);
    } finally {
      await mounted.cleanup();
    }
  });

  it("fetches the visible route page when the sync snapshot omits it", async () => {
    const mounted = await mountApp();

    try {
      await vi.waitFor(() => {
        expect(getThreadTurnsPageRequests).toEqual([THREAD_ID]);
        expect(useStore.getState().threadDetailSyncById?.[THREAD_ID]).toBe("synced");
        expect(acknowledgementObservations).toHaveLength(1);
      });

      expect(subscribeSyncRequestCount).toBe(1);
      expect(getThreadFromState(useStore.getState(), THREAD_ID)?.messages).toMatchObject([
        { text: "root message" },
      ]);
      expect(acknowledgementObservations[0]).toMatchObject({
        deliveryId: "sync-snapshot-1",
        appliedSequence: 1,
        rootTitle: "Root test thread",
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("applies streamed events in order and cumulatively acknowledges applied state", async () => {
    activePageThreadIds = [THREAD_ID];
    const mounted = await mountApp();

    try {
      await vi.waitFor(() => expect(acknowledgementObservations).toHaveLength(1));

      const firstEvent = createThreadUpdatedEvent({
        sequence: 2,
        title: "First streamed title",
        occurredAt: "2026-03-04T12:00:01.000Z",
      });
      const secondEvent = createThreadUpdatedEvent({
        sequence: 3,
        title: "Second streamed title",
        occurredAt: "2026-03-04T12:00:02.000Z",
      });
      sendSyncDelivery({ kind: "event", deliveryId: "sync-event-2", event: firstEvent });
      sendSyncDelivery({ kind: "event", deliveryId: "sync-event-3", event: secondEvent });

      await vi.waitFor(() => {
        expect(acknowledgementObservations.at(-1)?.appliedSequence).toBe(3);
      });

      expect(acknowledgementObservations.at(-1)).toMatchObject({
        deliveryId: "sync-event-3",
        appliedSequence: 3,
        rootTitle: "Second streamed title",
      });
      expect(getThreadFromState(useStore.getState(), THREAD_ID)?.title).toBe(
        "Second streamed title",
      );
      expect(subscribeSyncRequestCount).toBe(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it.each(PROVIDER_RECOVERY_CASES)(
    "recovers the canonical %s sync stream after one renderer application failure",
    async (_providerLabel, modelSelection) => {
      activePageThreadIds = [THREAD_ID];
      fixture = {
        ...fixture,
        snapshot: {
          ...fixture.snapshot,
          threads: fixture.snapshot.threads.map((thread) => ({
            ...thread,
            modelSelection,
            session: thread.session
              ? { ...thread.session, providerName: modelSelection.provider }
              : thread.session,
          })),
        },
      };
      const applyOrchestrationEvents = useStore.getState().applyOrchestrationEvents;
      let failNextEventBatch = true;
      useStore.setState({
        applyOrchestrationEvents: (events) => {
          if (failNextEventBatch) {
            failNextEventBatch = false;
            throw new Error("forced renderer application failure");
          }
          applyOrchestrationEvents(events);
        },
      });
      const mounted = await mountApp();

      try {
        await vi.waitFor(() => expect(acknowledgementObservations).toHaveLength(1));

        sendSyncDelivery({
          kind: "event",
          deliveryId: "sync-event-failed",
          event: createThreadUpdatedEvent({
            sequence: 2,
            title: "Must not partially apply",
            occurredAt: "2026-03-04T12:00:01.000Z",
          }),
        });

        await vi.waitFor(() => {
          const samples = getChatLifecycleDiagnosticSamples(THREAD_ID);
          expect(
            samples.some(
              (sample) =>
                sample.event === "sync-publication-apply-failed" &&
                sample.firstOrchestrationSequence === 2,
            ),
          ).toBe(true);
          expect(
            samples.some(
              (sample) =>
                sample.event === "sync-publication-recovery-scheduled" &&
                sample.firstOrchestrationSequence === 2 &&
                sample.recoveryAttempt === 1,
            ),
          ).toBe(true);
        });
        expect(getThreadFromState(useStore.getState(), THREAD_ID)?.title).toBe("Root test thread");
        expect(acknowledgementObservations.at(-1)?.appliedSequence).toBe(1);

        await vi.waitFor(() => expect(subscribeSyncRequestCount).toBe(2));
        sendSyncDelivery({
          kind: "event",
          deliveryId: "sync-event-recovered",
          event: createThreadUpdatedEvent({
            sequence: 3,
            title: "Recovered streamed title",
            occurredAt: "2026-03-04T12:00:02.000Z",
          }),
        });

        await vi.waitFor(() => {
          expect(getThreadFromState(useStore.getState(), THREAD_ID)?.title).toBe(
            "Recovered streamed title",
          );
          expect(acknowledgementObservations.at(-1)?.appliedSequence).toBe(3);
          expect(
            getChatLifecycleDiagnosticSamples("*").some(
              (sample) =>
                sample.event === "sync-publication-recovered" && sample.recoveryAttempt === 1,
            ),
          ).toBe(true);
          expect(getPersistedChatSyncIncidents().map((sample) => sample.event)).toEqual([
            "sync-publication-apply-failed",
            "sync-publication-recovery-scheduled",
            "sync-publication-recovered",
            "sync-publication-recovered",
          ]);
        });
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it("applies a large FIFO backlog while a cumulative acknowledgement is still pending", async () => {
    activePageThreadIds = [THREAD_ID];
    const mounted = await mountApp();
    let streamedTitleStoreUpdates = 0;
    const unsubscribeStoreUpdates = useStore.subscribe((state, previousState) => {
      const title = getThreadFromState(state, THREAD_ID)?.title;
      const previousTitle = getThreadFromState(previousState, THREAD_ID)?.title;
      if (title !== previousTitle && title?.startsWith("Streamed title ")) {
        streamedTitleStoreUpdates += 1;
      }
    });

    try {
      await vi.waitFor(() => expect(acknowledgementObservations).toHaveLength(1));
      holdSyncAcknowledgements = true;

      for (let sequence = 2; sequence <= 201; sequence += 1) {
        sendSyncDelivery({
          kind: "event",
          deliveryId: "sync-lease-1",
          event: createThreadUpdatedEvent({
            sequence,
            title: `Streamed title ${sequence}`,
            occurredAt: new Date(Date.parse(NOW_ISO) + sequence * 1_000).toISOString(),
          }),
        });
      }

      await vi.waitFor(() => {
        expect(getThreadFromState(useStore.getState(), THREAD_ID)?.title).toBe(
          "Streamed title 201",
        );
      });
      expect(streamedTitleStoreUpdates).toBe(1);
      await vi.waitFor(() => expect(acknowledgementObservations).toHaveLength(2));

      holdSyncAcknowledgements = false;
      for (const respond of heldSyncAcknowledgementExits.splice(0)) respond();
      await vi.waitFor(() => {
        expect(acknowledgementObservations.at(-1)?.appliedSequence).toBe(201);
      });
    } finally {
      unsubscribeStoreUpdates();
      holdSyncAcknowledgements = false;
      for (const respond of heldSyncAcknowledgementExits.splice(0)) respond();
      await mounted.cleanup();
    }
  });

  it("batches sustained canonical tool-output publication across visible and background threads", async () => {
    activePageThreadIds = [THREAD_ID];
    const mounted = await mountApp(THREAD_ID);

    const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    const measureSyncBurst = async (threadId: ThreadId, firstSequence: number) => {
      let storeUpdates = 0;
      let visibleThreadChanges = 0;
      let backgroundThreadChanges = 0;
      let sidebarSummaryChanges = 0;
      const unsubscribe = useStore.subscribe((state, previousState) => {
        storeUpdates += 1;
        if (getThreadFromState(state, THREAD_ID) !== getThreadFromState(previousState, THREAD_ID)) {
          visibleThreadChanges += 1;
        }
        if (
          getThreadFromState(state, OTHER_THREAD_ID) !==
          getThreadFromState(previousState, OTHER_THREAD_ID)
        ) {
          backgroundThreadChanges += 1;
        }
        if (state.sidebarThreadSummaryById !== previousState.sidebarThreadSummaryById) {
          sidebarSummaryChanges += 1;
        }
      });
      try {
        for (let offset = 0; offset < 12; offset += 1) {
          const sequence = firstSequence + offset;
          sendSyncDelivery({
            kind: "event",
            deliveryId: "sync-lease-activity",
            event: createThreadActivityReadModelEvent({ sequence, threadId }),
          });
          await nextTask();
        }
        await vi.waitFor(() => {
          expect(acknowledgementObservations.at(-1)?.appliedSequence).toBe(firstSequence + 11);
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        return {
          storeUpdates,
          visibleThreadChanges,
          backgroundThreadChanges,
          sidebarSummaryChanges,
        };
      } finally {
        unsubscribe();
      }
    };

    try {
      await vi.waitFor(() => {
        expect(acknowledgementObservations).toHaveLength(1);
        expect(domainStreamRequestCount).toBe(0);
      });

      const visible = await measureSyncBurst(THREAD_ID, 2);
      const background = await measureSyncBurst(OTHER_THREAD_ID, 14);

      expect(visible).toMatchObject({
        storeUpdates: 1,
        visibleThreadChanges: 1,
        backgroundThreadChanges: 0,
        sidebarSummaryChanges: 1,
      });
      expect(background).toMatchObject({
        storeUpdates: 1,
        visibleThreadChanges: 0,
        backgroundThreadChanges: 1,
        sidebarSummaryChanges: 1,
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("applies canonical tool activity while the renderer is hidden without waiting for a throttled timer", async () => {
    activePageThreadIds = [THREAD_ID];
    const mounted = await mountApp(THREAD_ID);

    try {
      await vi.waitFor(() => expect(acknowledgementObservations).toHaveLength(1));

      const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      try {
        sendSyncDelivery({
          kind: "event",
          deliveryId: "sync-hidden-canonical-operation",
          event: createThreadActivityReadModelEvent({ sequence: 2, threadId: THREAD_ID }),
        });
        await vi.waitFor(() => {
          expect(
            getChatLifecycleDiagnosticSamples(THREAD_ID).some(
              (sample) =>
                sample.event === "sync-publication-flushed" &&
                sample.firstOrchestrationSequence === 2 &&
                sample.rendererVisibility === "hidden" &&
                sample.reason === "delivery",
            ),
          ).toBe(true);
          expect(
            getThreadFromState(useStore.getState(), THREAD_ID)?.activities.some(
              (activity) => activity.id === "operation-2",
            ),
          ).toBe(true);
        });
      } finally {
        visibility.mockRestore();
      }
    } finally {
      await mounted.cleanup();
    }
  });

  it("applies canonical tool activity while a visible renderer is unfocused", async () => {
    activePageThreadIds = [THREAD_ID];
    const mounted = await mountApp(THREAD_ID);

    try {
      await vi.waitFor(() => expect(acknowledgementObservations).toHaveLength(1));
      vi.mocked(document.hasFocus).mockReturnValue(false);

      sendSyncDelivery({
        kind: "event",
        deliveryId: "sync-unfocused-canonical-operation",
        event: createThreadActivityReadModelEvent({ sequence: 2, threadId: THREAD_ID }),
      });

      await vi.waitFor(() => {
        expect(
          getChatLifecycleDiagnosticSamples(THREAD_ID).some(
            (sample) =>
              sample.event === "sync-publication-flushed" &&
              sample.firstOrchestrationSequence === 2 &&
              sample.rendererVisibility === "visible" &&
              sample.rendererHasFocus === false &&
              sample.reason === "delivery",
          ),
        ).toBe(true);
        expect(
          getThreadFromState(useStore.getState(), THREAD_ID)?.activities.some(
            (activity) => activity.id === "operation-2",
          ),
        ).toBe(true);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("flushes a focused canonical tool batch when the renderer loses focus", async () => {
    activePageThreadIds = [THREAD_ID];
    const mounted = await mountApp(THREAD_ID);

    try {
      await vi.waitFor(() => expect(acknowledgementObservations).toHaveLength(1));

      sendSyncDelivery({
        kind: "event",
        deliveryId: "sync-focused-before-blur-canonical-operation",
        event: createThreadActivityReadModelEvent({ sequence: 2, threadId: THREAD_ID }),
      });
      await vi.waitFor(() => {
        expect(
          getChatLifecycleDiagnosticSamples(THREAD_ID).some(
            (sample) =>
              sample.event === "sync-publication-queued" &&
              sample.firstOrchestrationSequence === 2 &&
              sample.rendererHasFocus === true,
          ),
        ).toBe(true);
      });

      vi.mocked(document.hasFocus).mockReturnValue(false);
      window.dispatchEvent(new Event("blur"));

      await vi.waitFor(() => {
        expect(
          getChatLifecycleDiagnosticSamples(THREAD_ID).some(
            (sample) =>
              sample.event === "sync-publication-flushed" &&
              sample.firstOrchestrationSequence === 2 &&
              sample.rendererHasFocus === false &&
              sample.reason === "window-blur",
          ),
        ).toBe(true);
        expect(
          getThreadFromState(useStore.getState(), THREAD_ID)?.activities.some(
            (activity) => activity.id === "operation-2",
          ),
        ).toBe(true);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("flushes a visible canonical tool batch when the renderer becomes hidden", async () => {
    activePageThreadIds = [THREAD_ID];
    const mounted = await mountApp(THREAD_ID);

    try {
      await vi.waitFor(() => expect(acknowledgementObservations).toHaveLength(1));

      let rendererVisibility: DocumentVisibilityState = "visible";
      const visibility = vi
        .spyOn(document, "visibilityState", "get")
        .mockImplementation(() => rendererVisibility);
      try {
        sendSyncDelivery({
          kind: "event",
          deliveryId: "sync-visible-before-hidden-canonical-operation",
          event: createThreadActivityReadModelEvent({ sequence: 2, threadId: THREAD_ID }),
        });
        await vi.waitFor(() => {
          expect(
            getChatLifecycleDiagnosticSamples(THREAD_ID).some(
              (sample) =>
                sample.event === "sync-publication-queued" &&
                sample.firstOrchestrationSequence === 2 &&
                sample.rendererVisibility === "visible",
            ),
          ).toBe(true);
        });
        rendererVisibility = "hidden";
        document.dispatchEvent(new Event("visibilitychange"));

        await vi.waitFor(() => {
          expect(
            getChatLifecycleDiagnosticSamples(THREAD_ID).some(
              (sample) =>
                sample.event === "sync-publication-flushed" &&
                sample.firstOrchestrationSequence === 2 &&
                sample.rendererVisibility === "hidden" &&
                sample.reason === "visibility-hidden",
            ),
          ).toBe(true);
          expect(
            getThreadFromState(useStore.getState(), THREAD_ID)?.activities.some(
              (activity) => activity.id === "operation-2",
            ),
          ).toBe(true);
        });
      } finally {
        visibility.mockRestore();
      }
    } finally {
      await mounted.cleanup();
    }
  });

  it("hydrates a newly visible route page without opening another sync subscription", async () => {
    activePageThreadIds = [THREAD_ID];
    const mounted = await mountApp();

    try {
      await vi.waitFor(() => {
        expect(useStore.getState().threadDetailSyncById?.[THREAD_ID]).toBe("synced");
        expect(acknowledgementObservations).toHaveLength(1);
      });
      expect(getThreadTurnsPageRequests).toEqual([]);

      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: OTHER_THREAD_ID },
      });

      await vi.waitFor(() => {
        expect(getThreadTurnsPageRequests).toEqual([OTHER_THREAD_ID]);
        expect(useStore.getState().threadDetailSyncById?.[OTHER_THREAD_ID]).toBe("synced");
      });
      expect(getThreadFromState(useStore.getState(), OTHER_THREAD_ID)?.messages).toMatchObject([
        { text: "other message" },
      ]);
      expect(subscribeSyncRequestCount).toBe(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("reconciles authoritative tool activity when a previously synced thread is reopened", async () => {
    activePageThreadIds = [THREAD_ID];
    const mounted = await mountApp();

    try {
      await vi.waitFor(() => {
        expect(useStore.getState().threadDetailSyncById?.[THREAD_ID]).toBe("synced");
        expect(acknowledgementObservations).toHaveLength(1);
      });

      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: OTHER_THREAD_ID },
      });
      await vi.waitFor(() => {
        expect(getThreadTurnsPageRequests).toEqual([OTHER_THREAD_ID]);
      });

      const rootThread = getFixtureThread(THREAD_ID);
      const missedTurnId = TurnId.makeUnsafe("turn-missed-while-inactive");
      const missedMessage = {
        id: MessageId.makeUnsafe("message-missed-while-inactive"),
        role: "assistant",
        text: "Assistant update while inactive",
        turnId: missedTurnId,
        streaming: false,
        source: "native",
        createdAt: "2026-03-04T12:00:02.000Z",
        updatedAt: "2026-03-04T12:00:02.000Z",
      } as const;
      const missedActivity = makeActivity({
        id: "activity-missed-while-inactive",
        turnId: missedTurnId,
        createdAt: "2026-03-04T12:00:03.000Z",
        kind: "tool.completed",
        summary: "Missed tool while inactive",
        payload: { itemType: "command_execution", detail: "completed while away" },
      });
      fixture.snapshot = {
        ...fixture.snapshot,
        snapshotSequence: 2,
        threads: fixture.snapshot.threads.map((thread) =>
          thread.id === THREAD_ID
            ? {
                ...rootThread,
                messages: [...rootThread.messages, missedMessage],
                activities: [...rootThread.activities, missedActivity],
              }
            : thread,
        ),
      };

      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: THREAD_ID },
      });

      await vi.waitFor(() => {
        expect(getThreadTurnsPageRequests).toEqual([OTHER_THREAD_ID, THREAD_ID]);
        expect(
          getThreadFromState(useStore.getState(), THREAD_ID)?.activities.some(
            (activity) => activity.id === "activity-missed-while-inactive",
          ),
        ).toBe(true);
        expect(document.body.textContent).toContain("Assistant update while inactive");
        expect(document.body.textContent).toContain("completed while away");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not discard reopened history when unrelated shell state changes before the page returns", async () => {
    activePageThreadIds = [THREAD_ID];
    const mounted = await mountApp();

    try {
      await vi.waitFor(() => {
        expect(useStore.getState().threadDetailSyncById?.[THREAD_ID]).toBe("synced");
      });
      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: OTHER_THREAD_ID },
      });
      await vi.waitFor(() => expect(getThreadTurnsPageRequests).toEqual([OTHER_THREAD_ID]));

      const rootThread = getFixtureThread(THREAD_ID);
      const missedTurnId = TurnId.makeUnsafe("turn-missed-during-reopen-race");
      fixture.snapshot = {
        ...fixture.snapshot,
        snapshotSequence: 2,
        threads: fixture.snapshot.threads.map((thread) =>
          thread.id === THREAD_ID
            ? {
                ...rootThread,
                messages: [
                  ...rootThread.messages,
                  {
                    id: MessageId.makeUnsafe("message-missed-during-reopen-race"),
                    role: "assistant",
                    text: "Assistant update before reopening",
                    turnId: missedTurnId,
                    streaming: false,
                    source: "native",
                    createdAt: "2026-03-04T12:00:02.000Z",
                    updatedAt: "2026-03-04T12:00:02.000Z",
                  },
                ],
                activities: [
                  ...rootThread.activities,
                  makeActivity({
                    id: "activity-missed-during-reopen-race",
                    turnId: missedTurnId,
                    createdAt: "2026-03-04T12:00:03.000Z",
                    kind: "tool.completed",
                    summary: "Missed tool before reopening",
                    payload: { itemType: "command_execution", detail: "historical tool output" },
                  }),
                ],
              }
            : thread,
        ),
      };

      holdThreadTurnsPageRequests = true;
      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: THREAD_ID },
      });
      await vi.waitFor(() =>
        expect(getThreadTurnsPageRequests).toEqual([OTHER_THREAD_ID, THREAD_ID]),
      );

      // A shell reconciliation can replace the id registry while preserving its
      // contents. That rerender must not revoke the already-authorized page read.
      useStore.setState((state) => ({ ...state, threadIds: [...(state.threadIds ?? [])] }));
      for (const respond of heldThreadTurnsPageExits.splice(0)) respond();
      holdThreadTurnsPageRequests = false;

      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Assistant update before reopening");
        expect(document.body.textContent).toContain("historical tool output");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("cleans up before remounting without leaking a duplicate sync subscription", async () => {
    activePageThreadIds = [THREAD_ID];
    const firstMount = await mountApp();

    try {
      await vi.waitFor(() => {
        expect(subscribeSyncRequestCount).toBe(1);
        expect(acknowledgementObservations).toHaveLength(1);
      });
    } finally {
      await firstMount.cleanup();
    }

    const secondMount = await mountApp();
    try {
      await vi.waitFor(() => {
        expect(subscribeSyncRequestCount).toBe(2);
        expect(acknowledgementObservations).toHaveLength(2);
      });
      expect(
        acknowledgementObservations.map(({ deliveryId, appliedSequence }) => ({
          deliveryId,
          appliedSequence,
        })),
      ).toEqual([
        { deliveryId: "sync-snapshot-1", appliedSequence: 1 },
        { deliveryId: "sync-snapshot-1", appliedSequence: 1 },
      ]);
    } finally {
      await secondMount.cleanup();
    }

    expect(subscribeSyncRequestCount).toBe(2);
  });
});
