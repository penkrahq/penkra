import type { TestProviderUpdate as OrchestrationEvent } from "../storeTestFixtures";
import type { FixtureReadModel as ContractReadModel } from "../test/effectRpcWebSocketMock.ts";
import "../index.css";
import { resetThreadListForTests } from "../threadListStore";

import {
  type CleanCoreThreadItem,
  EventId,
  FolderId,
  MessageId,
  SpaceId,
  ThreadId,
  TurnId,
  type OrchestrationGetThreadTurnsPageResult,
  type OrchestrationThread as ContractThread,
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

import {
  enableChatScrollDiagnostics,
  disableChatScrollDiagnostics,
  resetChatScrollDiagnostics,
  getChatScrollDiagnosticSamples,
} from "../chatScrollDiagnostics";
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
  createStartupSnapshotFromReadModel,
  createThreadShellFromReadModel,
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

type OrchestrationThread = ContractThread & {
  runtimeMode: import("@penkra/contracts").RuntimeMode;
  sidebarSortOrder?: number;
  lastActivityAt?: string | null;
  lastMessagePreview?: string | null;
  latestUserMessageAt?: string | null;
  lastVisitedAt?: string | null;
};
type OrchestrationReadModel = Omit<ContractReadModel, "threads"> & {
  threads: readonly OrchestrationThread[];
};

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
  threadError: string | null;
  rootMessageTexts: string[];
  rootDetailSync: string | null;
}

let fixture: TestFixture;
let subscribeSyncRequestCount = 0;
let syncStreamRequestId: string | null = null;
let navigationStreamClient: Parameters<typeof sendEffectRpcChunk>[0] | undefined;
let navigationReadCount = 0;
let navigationStreamRequestId: string | undefined;
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

function createThreadItemsPageFromFixtureSnapshot(threadId: ThreadId) {
  const thread = getFixtureThread(threadId);
  if (!thread) {
    return { items: [], turns: {}, nextCursor: null };
  }
  const pending: Array<{ at: string; item: Omit<CleanCoreThreadItem, "seq"> }> = [];
  for (const message of thread.messages) {
    pending.push({
      at: message.createdAt,
      item: {
        threadId,
        sourceId: message.id,
        turnId: message.turnId ?? null,
        kind: message.role === "user" ? "user" : "text",
        status: message.streaming ? "streaming" : message.role === "user" ? "sent" : "done",
        text: message.text,
        data:
          message.role === "user" &&
          ((message.attachments?.length ?? 0) > 0 ||
            (message.skills?.length ?? 0) > 0 ||
            (message.mentions?.length ?? 0) > 0)
            ? JSON.stringify({
                attachments: message.attachments ?? [],
                skills: message.skills ?? [],
                mentions: message.mentions ?? [],
                ...((message as { dispatchMode?: string }).dispatchMode
                  ? { dispatchMode: (message as { dispatchMode?: string }).dispatchMode }
                  : {}),
                ...((message as { dispatchOrigin?: string }).dispatchOrigin
                  ? { dispatchOrigin: (message as { dispatchOrigin?: string }).dispatchOrigin }
                  : {}),
              })
            : null,
        createdAt: message.createdAt,
        updatedAt:
          (message as { updatedAt?: string }).updatedAt ??
          (message as { completedAt?: string }).completedAt ??
          message.createdAt,
      },
    });
  }
  for (const activity of thread.activities) {
    const kind = activity.kind.startsWith("tool.")
      ? "tool"
      : activity.kind === "reasoning"
        ? "reasoning"
        : "notice";
    const payload = (activity.payload ?? null) as Record<string, unknown> | null;
    const payloadStatus =
      typeof payload?.status === "string" ? payload.status.toLowerCase() : undefined;
    const toolRunning =
      activity.kind !== "tool.completed" &&
      (payloadStatus === undefined ||
        payloadStatus === "inprogress" ||
        payloadStatus === "running" ||
        payloadStatus === "started");
    const turnState = thread.latestTurn?.state;
    // Mirror the clean core: a running tool item settles when its turn ends.
    const toolStatus = !toolRunning
      ? payloadStatus === "failed" || payloadStatus === "error"
        ? "error"
        : "done"
      : turnState === "interrupted"
        ? "interrupted"
        : turnState === "error"
          ? "error"
          : turnState === "completed"
            ? "done"
            : "running";
    pending.push({
      at: activity.createdAt,
      item: {
        threadId,
        sourceId: activity.id,
        turnId: activity.turnId ?? null,
        kind,
        status: kind === "tool" ? toolStatus : "done",
        text: activity.summary,
        data: JSON.stringify({
          tone: activity.tone,
          kind: activity.kind,
          summary: activity.summary,
          payload: activity.payload,
        }),
        createdAt: activity.createdAt,
        updatedAt: activity.createdAt,
      },
    });
  }
  const items = pending
    .toSorted((left, right) => left.at.localeCompare(right.at))
    .map((entry, index) => ({ ...entry.item, seq: index + 1 })) as CleanCoreThreadItem[];
  return { items, turns: {}, nextCursor: null };
}

/** Push a clean-core thread change so mounted transcripts re-read thread_items. */
function summarizeFixtureThread(
  thread: OrchestrationThread,
): import("@penkra/contracts").CleanCoreThreadSummary {
  return {
    latestTurn:
      thread.latestTurn?.startedAt && thread.latestTurn.state !== "queued"
        ? {
            turnId: thread.latestTurn.turnId,
            status:
              thread.latestTurn.state === "completed"
                ? "done"
                : thread.latestTurn.state === "cancelled"
                  ? "interrupted"
                  : thread.latestTurn.state,
            startedAt: thread.latestTurn.startedAt,
            endedAt: thread.latestTurn.completedAt,
          }
        : null,
    id: thread.id,
    spaceId: TEST_SPACE_ID,
    folderId: thread.folderId,
    title: thread.title,
    provider: thread.modelSelection.provider,
    connectionId: thread.connectionId ?? null,
    model: thread.modelSelection.model,
    modelOptions: thread.modelSelection.options
      ? JSON.stringify(thread.modelSelection.options)
      : null,
    runtimeMode: thread.runtimeMode,
    state: thread.session?.status === "running" ? "running" : "idle",
    activeTurnId: thread.session?.activeTurnId ?? null,
    lastError: thread.session?.lastError ?? null,
    queue: JSON.stringify(
      (thread.messages ?? [])
        .filter((message) => thread.queuedMessageIds?.includes(message.id))
        .map((message) => ({
          messageId: message.id,
          text: message.text,
          attachments: message.attachments ?? [],
          senderThreadId: message.senderThreadId ?? null,
          dispatchOrigin: "user",
          queuedAt: message.createdAt,
        })),
    ),
    createdBy: "user",
    createdByThreadId: null,
    sidebarSortOrder: thread.sidebarSortOrder ?? null,
    lastActivityAt: thread.lastActivityAt ?? null,
    lastMessagePreview: thread.lastMessagePreview ?? null,
    lastUserMessageAt: thread.latestUserMessageAt ?? null,
    lastVisitedAt: thread.lastVisitedAt ?? null,
    openQuestionCount: 0,
    latestOpenQuestion: null,
    archivedAt: thread.archivedAt ?? null,
    deletedAt: thread.deletedAt,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}

function resolveUnaryRequest(method: string, body: Record<string, unknown>): unknown {
  if (method === WS_METHODS.cleanCoreGetThreadShell) {
    const thread = fixture.snapshot.threads.find((thread) => thread.id === body.threadId);
    return thread ? createThreadShellFromReadModel(thread) : null;
  }
  if (method === WS_METHODS.cleanCoreGetThread) {
    const thread = fixture.snapshot.threads.find((thread) => thread.id === body.threadId);
    return thread === undefined ? null : summarizeFixtureThread(thread);
  }
  if (method === WS_METHODS.cleanCoreListThreads)
    return {
      threads: fixture.snapshot.threads
        .filter(
          (thread) =>
            summarizeFixtureThread(thread).spaceId === body.spaceId &&
            thread.folderId === body.folderId &&
            thread.deletedAt === null,
        )
        .map(summarizeFixtureThread),
      nextCursor: null,
    };

  {}
  if (method === WS_METHODS.cleanCoreGetThreadDraft) return { draft: null, draftUpdatedAt: null };
  if (method === WS_METHODS.cleanCoreListThreadItemsPage)
    return createThreadItemsPageFromFixtureSnapshot(body.threadId as ThreadId);
  if (method === WS_METHODS.cleanCoreGetThreadRuntime)
    return { state: "idle", activeTurnId: null, lastError: null };
  if (method === WS_METHODS.cleanCoreGetNavigation) {
    navigationReadCount += 1;
    const { spaces, folders } = createStartupSnapshotFromReadModel(fixture.snapshot, []);
    return { spaces, folders };
  }
  if (method === WS_METHODS.cleanCoreGetBootstrap)
    return {
      runningThreads: fixture.snapshot.threads
        .filter((thread) => thread.session?.status === "running")
        .map(summarizeFixtureThread),
    };
  if (method === WS_METHODS.serverGetConfig) return fixture.serverConfig;
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

      {}
      {}
      {}
      if (method === WS_METHODS.subscribeServerLifecycle) {
        sendEffectRpcChunk(client, request.id, { type: "welcome", payload: fixture.welcome });
        return;
      }
      if (method === WS_METHODS.subscribeServerConfig) {
        sendEffectRpcChunk(client, request.id, { type: "snapshot", config: fixture.serverConfig });
        return;
      }
      if (method === WS_METHODS.cleanCoreSubscribeSidebar) {
        navigationStreamClient = client;
        navigationStreamRequestId = request.id;
        return;
      }
      if (
        method === WS_METHODS.cleanCoreSubscribeThread ||
        method === WS_METHODS.subscribeServerProviderStatuses ||
        method === WS_METHODS.subscribeServerSettings ||
        method === WS_METHODS.subscribeProjectWorkspaceChanges
      ) {
        return;
      }
      {}
      sendEffectRpcExit(client, request.id, resolveUnaryRequest(method, requestBody));
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

function createSessionUpdatedEvent(input: {
  sequence: number;
  title: string;
  occurredAt: string;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.makeUnsafe(`event-session-updated-${input.sequence}`),
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    type: "thread.session-set",
    payload: {
      threadId: THREAD_ID,
      session: {
        threadId: THREAD_ID,
        providerName: fixture.snapshot.threads[0]!.modelSelection.provider,
        status: "ready",
        activeTurnId: null,
        lastError: input.title,
        updatedAt: input.occurredAt,
      },
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

describe("EventRouter canonical navigation", () => {
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
    resetThreadListForTests();
    await resetWsNativeApiForTest();
    fixture = buildFixture();
    subscribeSyncRequestCount = 0;
    syncStreamRequestId = null;
    syncStreamClient = null;
    navigationReadCount = 0;
    navigationStreamClient = undefined;
    navigationStreamRequestId = undefined;
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

  it("re-reads canonical navigation on bare pushes and removes missing rows", async () => {
    const mounted = await mountApp();
    try {
      await vi.waitFor(() => expect(navigationStreamRequestId).toBeDefined());
      fixture = {
        ...fixture,
        snapshot: {
          ...fixture.snapshot,
          folders: fixture.snapshot.folders.map((row) => ({ ...row, title: "Canonical title" })),
        },
      };
      sendEffectRpcChunk(navigationStreamClient!, navigationStreamRequestId!, {
        kind: "navigation",
      });
      await vi.waitFor(() => expect(navigationReadCount).toBeGreaterThan(0));
      await vi.waitFor(() =>
        expect(useStore.getState().folders.find((row) => row.id === PROJECT_ID)?.name).toBe(
          "Canonical title",
        ),
      );
      fixture = { ...fixture, snapshot: { ...fixture.snapshot, folders: [] } };
      sendEffectRpcChunk(navigationStreamClient!, navigationStreamRequestId!, {
        kind: "navigation",
      });
      await vi.waitFor(() => expect(useStore.getState().folders).toEqual([]));
    } finally {
      await mounted.cleanup();
    }
  });
});
