import "../index.css";

import {
  EventId,
  FolderId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  SpaceId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationGetThreadTurnsPageResult,
  type OrchestrationReadModel,
  type OrchestrationSyncStreamItem,
  type OrchestrationThread,
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
import { useWorkspacePathsStore } from "../workspacePathsStore";
import { resetWsNativeApiForTest } from "../wsNativeApi";

const THREAD_ID = ThreadId.makeUnsafe("thread-root-browser-test");
const OTHER_THREAD_ID = ThreadId.makeUnsafe("thread-other-browser-test");
const PROJECT_ID = FolderId.makeUnsafe("project-root-browser-test");
const TEST_SPACE_ID = SpaceId.makeUnsafe("space-root-browser-test");
const NOW_ISO = "2026-03-04T12:00:00.000Z";

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
let getThreadTurnsPageRequests: ThreadId[] = [];
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
        sendEffectRpcExit(client, request.id, createThreadTurnsPage(threadId));
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
        method === WS_METHODS.subscribeOrchestrationDomainEvents ||
        method === WS_METHODS.subscribeProjectDevServerEvents ||
        method === WS_METHODS.subscribeProjectWorkspaceChanges
      ) {
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
    getThreadTurnsPageRequests = [];
    acknowledgementObservations = [];
    holdSyncAcknowledgements = false;
    for (const respond of heldSyncAcknowledgementExits.splice(0)) respond();
    document.body.innerHTML = "";
    localStorage.clear();
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
