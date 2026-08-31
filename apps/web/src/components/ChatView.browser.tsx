// Production CSS is part of the behavior under test because row height depends on it.
import "../index.css";

import {
  EventId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  ProviderConnectionId,
  type OrchestrationReadModel,
  type OrchestrationEvent,
  type FolderId,
  type ServerConfig,
  SpaceId,
  ThreadId,
  TurnId,
  type WsWelcomePayload,
  WS_METHODS,
  OrchestrationSessionStatus,
} from "@penkra/contracts";
import {
  ATTACHMENT_CANCEL_ROUTE_PATH,
  ATTACHMENT_UPLOAD_ROUTE_PATH,
} from "@penkra/shared/binaryTransfer";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { HttpResponse, http, ws } from "msw";
import { setupWorker } from "msw/browser";
import { page, userEvent } from "vitest/browser";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { type ComposerImageAttachment, useComposerDraftStore } from "../composerDraftStore";
import {
  AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
  getScrollContainerDistanceFromBottom,
} from "../chat-scroll";
import { useLatestProjectStore } from "../latestProjectStore";
import {
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  type TerminalContextDraft,
  removeInlineTerminalContextPlaceholder,
} from "../lib/terminalContext";
import { isMacPlatform } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { getRouter } from "../router";
import { useSplitViewStore } from "../splitViewStore";
import { useSpacesUiStore } from "../spacesUiStore";
import { useStore } from "../store";
import { initialState } from "../storeState";
import { makeDomainEvent } from "../storeTestFixtures";
import {
  createShellSnapshotFromReadModel,
  flattenEffectRpcRequestPayload,
  readEffectRpcClientMessage,
  sendEffectRpcChunk,
  sendEffectRpcExit,
} from "../test/effectRpcWebSocketMock";
import { createBrowserTestServerConfig, createFullscreenTestHost } from "../test/browserHarness";
import { useTerminalStateStore } from "../terminalStateStore";
import { resetRetainedThreadDetailSubscriptionsForTests } from "../threadDetailSubscriptionRetention";
import { useWorkspacePathsStore } from "../workspacePathsStore";
import { resetWsNativeApiForTest } from "../wsNativeApi";
import { useVoiceSessionCoordinatorStore } from "../voiceSessionCoordinator";
// Pre-transform the compiler-heavy component outside the first case's timeout.
// The router's auto-split route otherwise requests this module on first mount.
import "./ChatView";

const THREAD_ID = "thread-browser-test" as ThreadId;
const OTHER_THREAD_ID = "thread-browser-test-other" as ThreadId;
const DESTINATION_THREAD_ID = "thread-browser-test-destination" as ThreadId;
const THREAD_TITLE = "Browser test thread";
const UUID_ROUTE_RE = /^\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROJECT_ID = "project-1" as FolderId;
const OTHER_PROJECT_ID = "project-2" as FolderId;
const TEST_SPACE_ID = SpaceId.makeUnsafe("space-browser-test");
const TEST_CONNECTION_ID = ProviderConnectionId.makeUnsafe("connection-codex-browser");
const INBOX_FOLDER_ID = "folder-inbox" as FolderId;
const NOW_ISO = "2026-03-04T12:00:00.000Z";
const BASE_TIME_MS = Date.parse(NOW_ISO);
const ATTACHMENT_SVG = "<svg xmlns='http://www.w3.org/2000/svg' width='120' height='300'></svg>";
let attachmentResponseDelayMs = 0;
let attachmentUploadSequence = 0;
let emitDomainEvent: ((event: OrchestrationEvent) => void) | null = null;
let emitSyncDomainEvent: ((event: OrchestrationEvent) => void) | null = null;

interface WsRequestEnvelope {
  id: string;
  body: {
    _tag: string;
    [key: string]: unknown;
  };
}

interface TestFixture {
  snapshot: OrchestrationReadModel;
  serverConfig: ServerConfig;
  welcome: WsWelcomePayload;
  gitBranchByCwd: Record<string, string>;
}

let fixture: TestFixture;
const wsRequests: WsRequestEnvelope["body"][] = [];
const wsLink = ws.link(/ws(s)?:\/\/.*/);

interface ViewportSpec {
  name: string;
  width: number;
  height: number;
}

const DEFAULT_VIEWPORT: ViewportSpec = {
  name: "desktop",
  width: 960,
  height: 1_100,
};
const TEXT_VIEWPORT_MATRIX = [
  DEFAULT_VIEWPORT,
  {
    name: "tablet",
    width: 720,
    height: 1_024,
  },
  {
    name: "mobile",
    width: 430,
    height: 932,
  },
  {
    name: "narrow",
    width: 320,
    height: 700,
  },
] as const satisfies readonly ViewportSpec[];
interface MountedChatView {
  [Symbol.asyncDispose]: () => Promise<void>;
  cleanup: () => Promise<void>;
  measureLayout: () => Promise<ChatLayoutMeasurement>;
  setViewport: (viewport: ViewportSpec) => Promise<void>;
  router: ReturnType<typeof getRouter>;
}

interface ChatLayoutMeasurement {
  hostHeightPx: number;
  composerBottomPx: number;
  scrollClientHeightPx: number;
  scrollHeightPx: number;
  distanceFromBottomPx: number;
}

function isoAt(offsetSeconds: number): string {
  return new Date(BASE_TIME_MS + offsetSeconds * 1_000).toISOString();
}

function createBaseServerConfig(): ServerConfig {
  return createBrowserTestServerConfig(NOW_ISO);
}

function createUserMessage(options: {
  id: MessageId;
  text: string;
  offsetSeconds: number;
  attachments?: Array<{
    type: "image";
    id: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
  }>;
}) {
  return {
    id: options.id,
    role: "user" as const,
    text: options.text,
    ...(options.attachments ? { attachments: options.attachments } : {}),
    turnId: null,
    streaming: false,
    source: "native" as const,
    createdAt: isoAt(options.offsetSeconds),
    updatedAt: isoAt(options.offsetSeconds + 1),
  };
}

function createAssistantMessage(options: { id: MessageId; text: string; offsetSeconds: number }) {
  return {
    id: options.id,
    role: "assistant" as const,
    text: options.text,
    turnId: null,
    streaming: false,
    source: "native" as const,
    createdAt: isoAt(options.offsetSeconds),
    updatedAt: isoAt(options.offsetSeconds + 1),
  };
}

function createTerminalContext(input: {
  id: string;
  terminalLabel: string;
  lineStart: number;
  lineEnd: number;
  text: string;
}): TerminalContextDraft {
  return {
    id: input.id,
    threadId: THREAD_ID,
    terminalId: `terminal-${input.id}`,
    terminalLabel: input.terminalLabel,
    lineStart: input.lineStart,
    lineEnd: input.lineEnd,
    text: input.text,
    createdAt: NOW_ISO,
  };
}

function createComposerImage(input: {
  id: string;
  previewUrl: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
}): ComposerImageAttachment {
  const name = input.name ?? "queued-image.png";
  const mimeType = input.mimeType ?? "image/png";
  const sizeBytes = input.sizeBytes ?? 8;
  const file = new File([new Uint8Array(sizeBytes).fill(1)], name, {
    type: mimeType,
    lastModified: BASE_TIME_MS,
  });
  return {
    type: "image",
    id: input.id,
    name,
    mimeType,
    sizeBytes: file.size,
    previewUrl: input.previewUrl,
    file,
  };
}

function createSnapshotForTargetUser(options: {
  targetMessageId: MessageId;
  targetText: string;
  targetAttachmentCount?: number;
  sessionStatus?: OrchestrationSessionStatus;
}): OrchestrationReadModel {
  const messages: Array<OrchestrationReadModel["threads"][number]["messages"][number]> = [];

  for (let index = 0; index < 22; index += 1) {
    const isTarget = index === 3;
    const userId = `msg-user-${index}` as MessageId;
    const assistantId = `msg-assistant-${index}` as MessageId;
    const attachments =
      isTarget && (options.targetAttachmentCount ?? 0) > 0
        ? Array.from({ length: options.targetAttachmentCount ?? 0 }, (_, attachmentIndex) => ({
            type: "image" as const,
            id: `attachment-${attachmentIndex + 1}`,
            name: `attachment-${attachmentIndex + 1}.png`,
            mimeType: "image/png",
            sizeBytes: 128,
          }))
        : undefined;

    messages.push(
      createUserMessage({
        id: isTarget ? options.targetMessageId : userId,
        text: isTarget ? options.targetText : `filler user message ${index}`,
        offsetSeconds: messages.length * 3,
        ...(attachments ? { attachments } : {}),
      }),
    );
    messages.push(
      createAssistantMessage({
        id: assistantId,
        text: `assistant filler ${index}`,
        offsetSeconds: messages.length * 3,
      }),
    );
  }

  return {
    snapshotSequence: 1,
    spaces: [
      {
        id: TEST_SPACE_ID,
        name: "Personal",
        icon: "bag",
        sortOrder: 0,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        archivedAt: null,
        deletedAt: null,
      },
    ],
    folders: [
      {
        id: PROJECT_ID,
        spaceId: TEST_SPACE_ID,
        title: "Project",
        workspaceRoot: "/repo/project",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: THREAD_ID,
        folderId: PROJECT_ID,
        title: THREAD_TITLE,
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        runtimeMode: "full-access",
        latestTurn: null,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
        messages,
        activities: [],
        session: {
          threadId: THREAD_ID,
          status: options.sessionStatus ?? "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW_ISO,
        },
      },
    ],
    updatedAt: NOW_ISO,
  };
}

function createSnapshotWithLongAssistantResponse(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-assistant-overflow-target" as MessageId,
    targetText: "start",
  });

  const threads = [...snapshot.threads];
  const threadIndex = threads.findIndex((thread) => thread.id === THREAD_ID);
  if (threadIndex < 0) {
    return snapshot;
  }

  const thread = threads[threadIndex]!;
  const messages = [...thread.messages];
  const messageIndex = messages.findIndex(
    (message, index) => message.role === "assistant" && index === 7,
  );
  if (messageIndex < 0) {
    return snapshot;
  }

  const message = messages[messageIndex]!;
  messages[messageIndex] = {
    ...message,
    text: Array.from(
      { length: 240 },
      (_, lineIndex) =>
        `${lineIndex + 1}. keep the viewport stable while this response keeps growing`,
    ).join("\n"),
  };
  threads[threadIndex] = {
    ...thread,
    messages,
  };

  return {
    ...snapshot,
    threads,
  };
}

function createSnapshotWithBottomAttachments(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-bottom-attachments" as MessageId,
    targetText: "bottom attachments",
  });

  const threads = [...snapshot.threads];
  const threadIndex = threads.findIndex((thread) => thread.id === THREAD_ID);
  if (threadIndex < 0) {
    return snapshot;
  }

  const thread = threads[threadIndex]!;
  const messages = [...thread.messages];
  let lastUserMessageIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      lastUserMessageIndex = index;
      break;
    }
  }
  if (lastUserMessageIndex < 0) {
    return snapshot;
  }

  const lastUserMessage = messages[lastUserMessageIndex]!;
  messages[lastUserMessageIndex] = {
    ...lastUserMessage,
    text: "final user message with delayed attachments",
    attachments: Array.from({ length: 3 }, (_, attachmentIndex) => ({
      type: "image" as const,
      id: `bottom-attachment-${attachmentIndex + 1}`,
      name: `bottom-attachment-${attachmentIndex + 1}.png`,
      mimeType: "image/png",
      sizeBytes: 128,
    })),
  };
  threads[threadIndex] = {
    ...thread,
    messages,
  };

  return {
    ...snapshot,
    threads,
  };
}

function buildFixture(snapshot: OrchestrationReadModel): TestFixture {
  return {
    snapshot,
    serverConfig: createBaseServerConfig(),
    gitBranchByCwd: {},
    welcome: {
      cwd: "/repo/project",
      projectName: "Project",
      bootstrapFolderId: PROJECT_ID,
      bootstrapThreadId: THREAD_ID,
    },
  };
}

function findThreadDetailFromFixtureSnapshot(
  threadId: ThreadId,
): OrchestrationReadModel["threads"][number] | null {
  return fixture.snapshot.threads.find((entry) => entry.id === threadId) ?? null;
}

function createThreadTurnsPageFromFixtureSnapshot(threadId: ThreadId) {
  const thread = findThreadDetailFromFixtureSnapshot(threadId);
  if (!thread) {
    throw new Error(`Unable to create a fixture turn page for missing Thread ${threadId}.`);
  }
  return {
    threadId,
    snapshotSequence: fixture.snapshot.snapshotSequence,
    conversationTurnCount: thread.messages.filter((message) => message.role === "user").length,
    messages: thread.messages,
    activities: thread.activities,
    pendingInteractions: thread.pendingInteractions ?? [],
    hasOlder: false,
    nextCursor: null,
  };
}

function addThreadToSnapshot(
  snapshot: OrchestrationReadModel,
  threadId: ThreadId,
  options?: { title?: string },
): OrchestrationReadModel {
  return {
    ...snapshot,
    snapshotSequence: snapshot.snapshotSequence + 1,
    threads: [
      ...snapshot.threads,
      {
        id: threadId,
        folderId: PROJECT_ID,
        title: options?.title ?? "New thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        runtimeMode: "full-access",
        latestTurn: null,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
        messages: [],
        activities: [],
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW_ISO,
        },
      },
    ],
  };
}

function createDraftOnlySnapshot(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-draft-target" as MessageId,
    targetText: "draft thread",
  });
  return {
    ...snapshot,
    threads: [],
  };
}

function withOpenProjectPickerFixtures(snapshot: OrchestrationReadModel): OrchestrationReadModel {
  const sourceThread = snapshot.threads[0];
  return {
    ...snapshot,
    folders: [
      ...snapshot.folders,
      {
        id: OTHER_PROJECT_ID,
        spaceId: snapshot.folders[0]!.spaceId,
        title: "Other Project",
        workspaceRoot: "/repo/other",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
    threads: sourceThread
      ? [
          { ...sourceThread, workingDirectory: "/repo/project" },
          {
            ...sourceThread,
            id: OTHER_THREAD_ID,
            title: "Other folder thread",
            workingDirectory: "/repo/other",
            messages: [],
            activities: [],
            session: sourceThread.session
              ? { ...sourceThread.session, threadId: OTHER_THREAD_ID }
              : null,
          },
        ]
      : [],
  };
}

function withInboxFolder(snapshot: OrchestrationReadModel): OrchestrationReadModel {
  return {
    ...snapshot,
    folders: [
      ...snapshot.folders,
      {
        id: INBOX_FOLDER_ID,
        spaceId: TEST_SPACE_ID,
        title: "Inbox",
        workspaceRoot: "/Users/tester",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
  };
}

function withActiveInboxThread(snapshot: OrchestrationReadModel): OrchestrationReadModel {
  const snapshotWithInboxFolder = withInboxFolder(snapshot);
  return {
    ...snapshotWithInboxFolder,
    threads: snapshotWithInboxFolder.threads.map((thread) =>
      thread.id === THREAD_ID ? { ...thread, folderId: INBOX_FOLDER_ID } : thread,
    ),
  };
}

function withProjectScripts(
  snapshot: OrchestrationReadModel,
  scripts: OrchestrationReadModel["folders"][number]["scripts"],
): OrchestrationReadModel {
  return {
    ...snapshot,
    folders: snapshot.folders.map((project) =>
      project.id === PROJECT_ID ? { ...project, scripts: Array.from(scripts) } : project,
    ),
  };
}

function createSnapshotWithHistoricalPlanMessage(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-plan-target" as MessageId,
    targetText: "plan thread",
  });
  const planMarkdown = [
    "# Ship plan mode follow-up",
    "",
    "- Step 1: capture the thread-open trace",
    "- Step 2: identify the main-thread bottleneck",
    "- Step 3: keep collapsed cards cheap",
    "- Step 4: render the full markdown only on demand",
    "- Step 5: preserve export and save actions",
    "- Step 6: add regression coverage",
    "- Step 7: verify route transitions stay responsive",
    "- Step 8: confirm no server-side work changed",
    "- Step 9: confirm short plans still render normally",
    "- Step 10: confirm long plans stay collapsed by default",
    "- Step 11: confirm preview text is still useful",
    "- Step 12: confirm plan follow-up flow still works",
    "- Step 13: confirm timeline virtualization still behaves",
    "- Step 14: confirm theme styling still looks correct",
    "- Step 15: confirm save dialog behavior is unchanged",
    "- Step 16: confirm download behavior is unchanged",
    "- Step 17: confirm code fences do not parse until expand",
    "- Step 18: confirm preview truncation ends cleanly",
    "- Step 19: confirm markdown links still open in editor after expand",
    "- Step 20: confirm deep hidden detail only appears after expand",
    "",
    "```ts",
    "export const hiddenPlanImplementationDetail = 'deep hidden detail only after expand';",
    "```",
  ].join("\n");

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? Object.assign({}, thread, {
            messages: [
              ...thread.messages,
              {
                id: MessageId.makeUnsafe("legacy-proposed-plan:plan-browser-test"),
                role: "assistant" as const,
                text: planMarkdown,
                turnId: null,
                createdAt: isoAt(1_000),
                updatedAt: isoAt(1_001),
                completedAt: isoAt(1_001),
                streaming: false,
                source: "native" as const,
              },
            ],
            updatedAt: isoAt(1_001),
          })
        : thread,
    ),
  };
}

function createSnapshotWithActiveInlinePlan(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-inline-plan-target" as MessageId,
    targetText: "inline plan thread",
    sessionStatus: "running",
  });
  const activeTurnId = TurnId.makeUnsafe("turn-inline-plan");

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? {
            ...thread,
            latestTurn: {
              turnId: activeTurnId,
              state: "running",
              requestedAt: isoAt(1_000),
              startedAt: isoAt(1_001),
              completedAt: null,
              assistantMessageId: null,
            },
            activities: [
              {
                id: EventId.makeUnsafe("activity-inline-plan"),
                createdAt: isoAt(1_002),
                kind: "turn.tasks.updated",
                summary: "Tasks updated",
                tone: "info",
                turnId: activeTurnId,
                payload: {
                  tasks: [
                    {
                      task: "Inspecting ChatView boundaries",
                      status: "inProgress",
                    },
                    {
                      task: "Patch the shared checklist receiver",
                      status: "pending",
                    },
                    {
                      task: "Run final validation",
                      status: "completed",
                    },
                  ],
                },
              },
              {
                id: EventId.makeUnsafe("activity-inline-background-task"),
                createdAt: isoAt(1_003),
                kind: "task.started",
                summary: "Background agent started",
                tone: "info",
                turnId: activeTurnId,
                payload: {
                  taskId: "task-inline-background-agent",
                  taskType: "subagent",
                },
              },
            ],
            session: thread.session
              ? {
                  ...thread.session,
                  status: "running",
                  activeTurnId,
                  updatedAt: isoAt(1_003),
                }
              : null,
            updatedAt: isoAt(1_003),
          }
        : thread,
    ),
  };
}

function createSnapshotWithSettledInlinePlan(): OrchestrationReadModel {
  const snapshot = createSnapshotWithActiveInlinePlan();
  const activeTurnId = TurnId.makeUnsafe("turn-inline-plan");

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? {
            ...thread,
            latestTurn: {
              turnId: activeTurnId,
              state: "completed",
              requestedAt: isoAt(1_000),
              startedAt: isoAt(1_001),
              completedAt: isoAt(1_004),
              assistantMessageId: MessageId.makeUnsafe("msg-assistant-inline-plan-complete"),
            },
            messages: [
              ...thread.messages,
              {
                turnId: activeTurnId,
                id: MessageId.makeUnsafe("msg-assistant-inline-plan-complete"),
                role: "assistant",
                text: "Finished the investigation.",
                createdAt: isoAt(1_004),
                updatedAt: isoAt(1_004),
                completedAt: isoAt(1_004),
                streaming: false,
                source: "native",
              },
            ],
            session: thread.session
              ? {
                  ...thread.session,
                  status: "ready",
                  activeTurnId: null,
                  updatedAt: isoAt(1_004),
                }
              : null,
            updatedAt: isoAt(1_004),
          }
        : thread,
    ),
  };
}

function createSnapshotWithSettledCompletedInlinePlan(): OrchestrationReadModel {
  const snapshot = createSnapshotWithSettledInlinePlan();

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? {
            ...thread,
            activities: thread.activities.map((activity) =>
              activity.kind === "turn.tasks.updated"
                ? {
                    ...activity,
                    payload: {
                      tasks: [
                        {
                          task: "Inspecting ChatView boundaries",
                          status: "completed",
                        },
                        {
                          task: "Patch the shared checklist receiver",
                          status: "completed",
                        },
                        { task: "Run final validation", status: "completed" },
                      ],
                    },
                  }
                : activity,
            ),
          }
        : thread,
    ),
  };
}

function createSnapshotWithInlineToolOverflow(options: {
  active: boolean;
}): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-inline-tools-target" as MessageId,
    targetText: "inline tools thread",
    sessionStatus: options.active ? "running" : "ready",
  });
  const activeTurnId = TurnId.makeUnsafe("turn-inline-tools");

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? {
            ...thread,
            latestTurn: {
              turnId: activeTurnId,
              state: options.active ? "running" : "completed",
              requestedAt: isoAt(1_100),
              startedAt: isoAt(1_101),
              completedAt: options.active ? null : isoAt(1_108),
              assistantMessageId: MessageId.makeUnsafe("msg-assistant-inline-tools"),
            },
            activities: Array.from({ length: 6 }, (_, index) => ({
              id: EventId.makeUnsafe(`activity-inline-tool-${index + 1}`),
              createdAt: isoAt(1_102 + index),
              kind: "tool.completed" as const,
              summary: `tool ${index + 1}`,
              tone: "tool" as const,
              turnId: activeTurnId,
              payload: {
                itemType: "dynamic_tool_call",
                toolName: `tool-${index + 1}`,
              },
            })),
            messages: [
              ...thread.messages,
              {
                turnId: activeTurnId,
                id: MessageId.makeUnsafe("msg-assistant-inline-tools"),
                role: "assistant",
                text: "Wrapped up the inline tool review.",
                createdAt: isoAt(1_109),
                updatedAt: isoAt(1_109),
                completedAt: options.active ? undefined : isoAt(1_109),
                streaming: false,
                source: "native",
              },
            ],
            session: thread.session
              ? {
                  ...thread.session,
                  status: options.active ? "running" : "ready",
                  activeTurnId: options.active ? activeTurnId : null,
                  updatedAt: options.active ? isoAt(1_107) : isoAt(1_108),
                }
              : null,
            updatedAt: options.active ? isoAt(1_107) : isoAt(1_109),
          }
        : thread,
    ),
  };
}

function createSnapshotWithInterruptedCommand(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-interrupted-command" as MessageId,
    targetText: "run the lifecycle check",
    sessionStatus: "stopped",
  });
  const turnId = TurnId.makeUnsafe("turn-interrupted-command");
  const settledAt = isoAt(1_120);

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? {
            ...thread,
            latestTurn: {
              turnId,
              state: "interrupted",
              requestedAt: isoAt(1_100),
              startedAt: isoAt(1_101),
              completedAt: settledAt,
              assistantMessageId: null,
            },
            activities: [
              {
                id: EventId.makeUnsafe("activity-interrupted-command"),
                createdAt: isoAt(1_102),
                kind: "tool.started",
                summary: "Ran command started",
                tone: "tool",
                turnId,
                payload: {
                  itemType: "command_execution",
                  status: "inProgress",
                  detail: "/bin/zsh -lc 'sleep 45'",
                  data: {
                    item: {
                      id: "command-interrupted",
                      type: "commandExecution",
                      command: "/bin/zsh -lc 'sleep 45'",
                      status: "inProgress",
                    },
                  },
                },
              },
            ],
            session: thread.session
              ? {
                  ...thread.session,
                  status: "stopped",
                  activeTurnId: null,
                  updatedAt: settledAt,
                }
              : null,
            updatedAt: settledAt,
          }
        : thread,
    ),
  };
}

function recordFolderCreateCommand(command: unknown): boolean {
  if (
    !command ||
    typeof command !== "object" ||
    !("type" in command) ||
    command.type !== "folder.create" ||
    !("folderId" in command) ||
    !("workspaceRoot" in command) ||
    !("title" in command)
  ) {
    return false;
  }

  const folderId = command.folderId as FolderId;
  const submittedDefaultModelSelection =
    "defaultModelSelection" in command &&
    command.defaultModelSelection &&
    typeof command.defaultModelSelection === "object" &&
    "provider" in command.defaultModelSelection &&
    typeof command.defaultModelSelection.provider === "string" &&
    "model" in command.defaultModelSelection &&
    typeof command.defaultModelSelection.model === "string" &&
    command.defaultModelSelection.model.length > 0
      ? (command.defaultModelSelection as OrchestrationReadModel["folders"][number]["defaultModelSelection"])
      : {
          provider: "codex" as const,
          model: "gpt-5",
        };
  fixture = {
    ...fixture,
    snapshot: {
      ...fixture.snapshot,
      snapshotSequence: fixture.snapshot.snapshotSequence + 1,
      folders: [
        ...fixture.snapshot.folders.filter((project) => project.id !== folderId),
        {
          id: folderId,
          spaceId:
            "spaceId" in command && typeof command.spaceId === "string"
              ? SpaceId.makeUnsafe(command.spaceId)
              : TEST_SPACE_ID,
          title: String(command.title),
          workspaceRoot: command.workspaceRoot === null ? null : String(command.workspaceRoot),
          defaultModelSelection: submittedDefaultModelSelection,
          scripts: [],
          createdAt:
            "createdAt" in command && typeof command.createdAt === "string"
              ? command.createdAt
              : NOW_ISO,
          updatedAt: NOW_ISO,
          deletedAt: null,
        },
      ],
      updatedAt: NOW_ISO,
    },
  };
  return true;
}

function recordSpaceCreateCommand(command: unknown): boolean {
  if (
    !command ||
    typeof command !== "object" ||
    !("type" in command) ||
    command.type !== "space.create" ||
    !("spaceId" in command) ||
    typeof command.spaceId !== "string" ||
    !("name" in command) ||
    typeof command.name !== "string"
  ) {
    return false;
  }
  const spaceId = SpaceId.makeUnsafe(command.spaceId);
  fixture = {
    ...fixture,
    snapshot: {
      ...fixture.snapshot,
      snapshotSequence: fixture.snapshot.snapshotSequence + 1,
      spaces: [
        ...fixture.snapshot.spaces.filter((space) => space.id !== spaceId),
        {
          id: spaceId,
          name: command.name,
          icon: "bag",
          sortOrder: fixture.snapshot.spaces.length,
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
          archivedAt: null,
          deletedAt: null,
        },
      ],
      updatedAt: NOW_ISO,
    },
  };
  return true;
}

function resolveWsRpc(body: WsRequestEnvelope["body"]): unknown {
  const tag = body._tag;
  if (tag === ORCHESTRATION_WS_METHODS.getShellSnapshot) {
    return createShellSnapshotFromReadModel(fixture.snapshot);
  }
  if (tag === ORCHESTRATION_WS_METHODS.getSnapshot) {
    return fixture.snapshot;
  }
  if (tag === ORCHESTRATION_WS_METHODS.getThreadTurnsPage && typeof body.threadId === "string") {
    return createThreadTurnsPageFromFixtureSnapshot(ThreadId.makeUnsafe(body.threadId));
  }
  if (tag === ORCHESTRATION_WS_METHODS.acknowledgeSync) {
    // Effect RPC encodes Schema.Void as null on the wire; returning undefined
    // would omit the success value from the serialized Exit.
    return null;
  }
  if (tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
    if (recordSpaceCreateCommand(body.command) || recordFolderCreateCommand(body.command)) {
      return { sequence: fixture.snapshot.snapshotSequence };
    }
    return { sequence: fixture.snapshot.snapshotSequence + 1 };
  }
  if (tag === WS_METHODS.serverGetConfig) {
    return fixture.serverConfig;
  }
  if (tag === WS_METHODS.providerGetConnections) {
    return {
      connections: [
        {
          id: "connection-codex-browser",
          harness: "codex",
          authenticationTargetId: "openai-first-party",
          authenticationMethodId: "chatgpt",
          label: "personal@example.com",
          providerIdentityId: "personal@example.com",
          health: "ready",
          healthReason: null,
          lastCheckedAt: NOW_ISO,
          lifecycle: "active",
          terminationReason: null,
          terminatedAt: null,
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
        },
      ],
      installations: [
        {
          id: "installation-codex-browser",
          harness: "codex",
          version: "1.0.0",
          platform: "darwin",
          architecture: "arm64",
          adapterVersion: "1",
          protocolVersion: "codex-app-server-v2",
          lifecycle: "active",
          healthReason: null,
          installedAt: NOW_ISO,
          activatedAt: NOW_ISO,
          retiredAt: null,
        },
        {
          id: "installation-opencode-browser",
          harness: "opencode",
          version: "1.0.0",
          platform: "darwin",
          architecture: "arm64",
          adapterVersion: "1",
          protocolVersion: "opencode-http-v1",
          lifecycle: "active",
          healthReason: null,
          installedAt: NOW_ISO,
          activatedAt: NOW_ISO,
          retiredAt: null,
        },
      ],
      anonymousRoutes: [{ harness: "opencode", internalProviderId: "opencode" }],
      authenticationMethods: [
        {
          harness: "codex",
          authenticationTargetId: "openai-first-party",
          authenticationMethodId: "chatgpt",
          kind: "managed-login",
          label: "ChatGPT account",
          internalProviderIds: [null],
        },
        {
          harness: "opencode",
          authenticationTargetId: "opencode-go",
          authenticationMethodId: "api-key",
          kind: "static-secret",
          label: "OpenCode Go",
          secretPlaceholder: "OpenCode Go key",
          internalProviderIds: ["opencode-go"],
        },
      ],
    };
  }
  if (tag === WS_METHODS.providerGetThreadBinding) {
    const thread = fixture.snapshot.threads.find((candidate) => candidate.id === body.threadId);
    const hasStarted =
      thread !== undefined &&
      (thread.messages.length > 0 || thread.latestTurn !== null || thread.session !== null);
    return {
      state: null,
      binding: hasStarted
        ? {
            threadId: thread.id,
            connectionId: "connection-codex-browser",
            installationId: "installation-codex-browser",
            internalProviderId: null,
            modelId: thread.modelSelection.model,
            revision: 0,
            createdAt: NOW_ISO,
            updatedAt: NOW_ISO,
          }
        : null,
    };
  }
  if (tag === WS_METHODS.providerGetComposerCapabilities) {
    return {
      provider: body.provider,
      supportsSkillMentions: true,
      supportsSkillDiscovery: true,
      supportsNativeSlashCommandDiscovery: false,
      supportsPluginMentions: false,
      supportsPluginDiscovery: false,
      supportsRuntimeModelList: true,
      supportsThreadCompaction: body.provider === "codex",
      supportsThreadFork: body.provider === "codex" || body.provider === "opencode",
      supportsThreadImport: false,
    };
  }
  if (tag === WS_METHODS.providerListAgents) return { agents: [], source: "test", cached: false };
  if (tag === WS_METHODS.providerListModels && body.provider === "codex") {
    return {
      models: [
        {
          slug: "gpt-5.5",
          name: "GPT-5.5",
          availableConnectionIds: ["connection-codex-browser"],
          supportedReasoningEfforts: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
          ],
          defaultReasoningEffort: "medium",
        },
        {
          slug: "gpt-5.2",
          name: "GPT-5.2",
          availableConnectionIds: ["connection-codex-browser"],
          supportedReasoningEfforts: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
          ],
          defaultReasoningEffort: "medium",
        },
      ],
      source: "codex-app-server",
      cached: false,
    };
  }
  if (tag === WS_METHODS.providerListModels && body.provider === "opencode") {
    return {
      models: [
        {
          slug: "opencode/deepseek-v4-flash-free",
          name: "Deepseek V4 Flash Free",
          availableConnectionIds: [null],
          supportedReasoningEfforts: [],
        },
      ],
      source: "managed-connections",
      cached: false,
    };
  }
  if (tag === WS_METHODS.projectsListDevServers) {
    return { servers: [] };
  }
  if (tag === WS_METHODS.projectsSearchEntries) {
    return {
      entries: [],
      truncated: false,
    };
  }
  if (tag === WS_METHODS.terminalOpen) {
    return {
      threadId: typeof body.threadId === "string" ? body.threadId : THREAD_ID,
      terminalId: typeof body.terminalId === "string" ? body.terminalId : "default",
      cwd: typeof body.cwd === "string" ? body.cwd : "/repo/project",
      status: "running",
      pid: 123,
      history: "",
      exitCode: null,
      exitSignal: null,
      updatedAt: NOW_ISO,
    };
  }
  if (tag === WS_METHODS.shellOpenInEditor || tag === WS_METHODS.terminalWrite) {
    return null;
  }
  return {};
}

function installDeterministicSendNativeApi(): () => void {
  const previousNativeApi = window.nativeApi;
  const wsNativeApi = readNativeApi();
  if (!wsNativeApi) {
    throw new Error("Expected browser native API fixture.");
  }

  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    value: {
      ...wsNativeApi,
      terminal: {
        ...wsNativeApi.terminal,
        open: async (input: Parameters<typeof wsNativeApi.terminal.open>[0]) => {
          const request: WsRequestEnvelope["body"] = {
            _tag: WS_METHODS.terminalOpen,
            ...input,
          };
          wsRequests.push(request);
          return resolveWsRpc(request) as Awaited<ReturnType<typeof wsNativeApi.terminal.open>>;
        },
        write: async (input: Parameters<typeof wsNativeApi.terminal.write>[0]) => {
          wsRequests.push({
            _tag: WS_METHODS.terminalWrite,
            ...input,
          });
        },
      },
      orchestration: {
        ...wsNativeApi.orchestration,
        dispatchCommand: async (
          command: Parameters<typeof wsNativeApi.orchestration.dispatchCommand>[0],
        ) => {
          wsRequests.push({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            command,
          });
          return { sequence: fixture.snapshot.snapshotSequence + 1 };
        },
      },
    },
  });

  return () => {
    if (previousNativeApi) {
      Object.defineProperty(window, "nativeApi", {
        configurable: true,
        value: previousNativeApi,
      });
    } else {
      Reflect.deleteProperty(window, "nativeApi");
    }
  };
}

function toRecordedWsRequestBody(request: {
  readonly tag: string;
  readonly payload: unknown;
}): WsRequestEnvelope["body"] {
  if (request.tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
    return {
      _tag: request.tag,
      command: request.payload,
    };
  }
  return flattenEffectRpcRequestPayload(request.tag, request.payload);
}

const worker = setupWorker(
  wsLink.addEventListener("connection", ({ client }) => {
    client.addEventListener("message", (event) => {
      const rawData = event.data;
      if (typeof rawData !== "string") return;
      const parsed = readEffectRpcClientMessage(client, rawData);
      if (parsed.kind !== "request") return;

      const requestBody = toRecordedWsRequestBody(parsed.request);
      const method = requestBody._tag;
      wsRequests.push(requestBody);

      if (method === WS_METHODS.subscribeServerLifecycle) {
        sendEffectRpcChunk(client, parsed.request.id, {
          type: "welcome",
          payload: fixture.welcome,
        });
        return;
      }
      if (method === WS_METHODS.subscribeServerConfig) {
        sendEffectRpcChunk(client, parsed.request.id, {
          type: "snapshot",
          config: fixture.serverConfig,
        });
        return;
      }
      if (method === ORCHESTRATION_WS_METHODS.subscribeShell) {
        sendEffectRpcChunk(client, parsed.request.id, {
          kind: "snapshot",
          snapshot: createShellSnapshotFromReadModel(fixture.snapshot),
        });
        return;
      }
      if (method === ORCHESTRATION_WS_METHODS.subscribeSync) {
        emitSyncDomainEvent = (event) =>
          sendEffectRpcChunk(client, parsed.request.id, {
            kind: "event",
            deliveryId: `fixture-sync-event-${event.sequence}`,
            event,
          });
        sendEffectRpcChunk(client, parsed.request.id, {
          kind: "snapshot",
          deliveryId: `fixture-sync-${fixture.snapshot.snapshotSequence}`,
          snapshot: {
            snapshotSequence: fixture.snapshot.snapshotSequence,
            shell: createShellSnapshotFromReadModel(fixture.snapshot),
            activeThreadPages: [],
          },
        });
        return;
      }
      if (method === ORCHESTRATION_WS_METHODS.subscribeThread && "threadId" in requestBody) {
        const threadId = requestBody.threadId as ThreadId;
        const thread = findThreadDetailFromFixtureSnapshot(threadId);
        if (!thread) {
          return;
        }
        sendEffectRpcChunk(client, parsed.request.id, {
          kind: "snapshot",
          snapshot: {
            snapshotSequence: fixture.snapshot.snapshotSequence,
            thread,
          },
        });
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
        if (method === WS_METHODS.subscribeOrchestrationDomainEvents) {
          emitDomainEvent = (event) => sendEffectRpcChunk(client, parsed.request.id, event);
        }
        return;
      }
      sendEffectRpcExit(client, parsed.request.id, resolveWsRpc(requestBody));
    });
  }),
  http.post(`*${ATTACHMENT_UPLOAD_ROUTE_PATH}`, async ({ request }) => {
    const url = new URL(request.url);
    const bytes = await request.arrayBuffer();
    attachmentUploadSequence += 1;
    return HttpResponse.json(
      {
        type: url.searchParams.get("type") ?? "file",
        id: `att_v2_${String(attachmentUploadSequence).padStart(32, "0")}`,
        name: url.searchParams.get("name") ?? "attachment.bin",
        mimeType: url.searchParams.get("mimeType") ?? "application/octet-stream",
        sizeBytes: bytes.byteLength,
      },
      { status: 201 },
    );
  }),
  http.post(`*${ATTACHMENT_CANCEL_ROUTE_PATH}`, () =>
    HttpResponse.json({ cancelled: true }, { status: 200 }),
  ),
  http.get("*/attachments/:attachmentId", async () => {
    if (attachmentResponseDelayMs > 0) {
      await new Promise<void>((resolve) => {
        globalThis.setTimeout(() => resolve(), attachmentResponseDelayMs);
      });
    }
    return HttpResponse.text(ATTACHMENT_SVG, {
      headers: {
        "Content-Type": "image/svg+xml",
      },
    });
  }),
  http.get("*/api/project-favicon", () => new HttpResponse(null, { status: 204 })),
);

async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

async function waitForLayout(): Promise<void> {
  await nextFrame();
  await nextFrame();
  await nextFrame();
}

async function dragWithPointerFrames(
  source: Element,
  target: Element,
  targetYRatio = 0.5,
  beforeFinish?: () => void | Promise<void>,
  finish: "drop" | "cancel" = "drop",
): Promise<void> {
  const sourceRect = source.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const start = {
    x: sourceRect.left + sourceRect.width / 2,
    y: sourceRect.top + sourceRect.height / 2,
  };
  const end = {
    x: targetRect.left + targetRect.width / 2,
    y: targetRect.top + targetRect.height * targetYRatio,
  };
  const pointerId = 41;
  const dispatch = (
    eventTarget: EventTarget,
    type: "pointercancel" | "pointerdown" | "pointermove" | "pointerup",
    x: number,
    y: number,
  ) => {
    eventTarget.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1,
        clientX: x,
        clientY: y,
        isPrimary: true,
        pointerId,
        pointerType: "mouse",
      }),
    );
  };
  const body = document.body;
  const setPointerCapture = body.setPointerCapture;
  const releasePointerCapture = body.releasePointerCapture;
  body.setPointerCapture = () => undefined;
  body.releasePointerCapture = () => undefined;

  try {
    dispatch(source, "pointerdown", start.x, start.y);
    await nextFrame();
    for (const progress of [0.35, 0.7, 1]) {
      dispatch(
        document,
        "pointermove",
        start.x + (end.x - start.x) * progress,
        start.y + (end.y - start.y) * progress,
      );
      await nextFrame();
    }
    await nextFrame();
    await beforeFinish?.();
    if (finish === "cancel") {
      dispatch(document, "pointercancel", end.x, end.y);
    } else {
      dispatch(document, "pointerup", end.x, end.y);
    }
    await nextFrame();
  } finally {
    body.setPointerCapture = setPointerCapture;
    body.releasePointerCapture = releasePointerCapture;
  }
}

async function setViewport(viewport: ViewportSpec): Promise<void> {
  await page.viewport(viewport.width, viewport.height);
  await waitForLayout();
}

async function waitForProductionStyles(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(
        getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
      ).not.toBe("");
      expect(getComputedStyle(document.body).marginTop).toBe("0px");
    },
    {
      timeout: 4_000,
      interval: 16,
    },
  );
}

async function waitForElement<T extends Element>(
  query: () => T | null,
  errorMessage: string,
): Promise<T> {
  let element: T | null = null;
  await vi.waitFor(
    () => {
      element = query();
      expect(element, errorMessage).toBeTruthy();
    },
    {
      timeout: 8_000,
      interval: 16,
    },
  );
  if (!element) {
    throw new Error(errorMessage);
  }
  return element;
}

async function waitForURL(
  router: ReturnType<typeof getRouter>,
  predicate: (pathname: string) => boolean,
  errorMessage: string,
): Promise<string> {
  let pathname = "";
  await vi.waitFor(
    () => {
      pathname = router.state.location.pathname;
      expect(predicate(pathname), errorMessage).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );
  return pathname;
}

async function waitForComposerEditor(): Promise<HTMLElement> {
  return waitForElement(
    () => document.querySelector<HTMLElement>('[contenteditable="true"]'),
    "Unable to find composer editor.",
  );
}

async function waitForSendButton(): Promise<HTMLButtonElement> {
  return waitForElement(
    () => document.querySelector<HTMLButtonElement>('button[aria-label="Send message"]'),
    "Unable to find send button.",
  );
}

function readDispatchedCommand(request: WsRequestEnvelope["body"]): Record<string, unknown> | null {
  if (
    request._tag !== ORCHESTRATION_WS_METHODS.dispatchCommand ||
    typeof request.command !== "object" ||
    request.command === null
  ) {
    return null;
  }
  return request.command as Record<string, unknown>;
}

function hasDispatchedCommandType(type: string): boolean {
  return wsRequests.some((request) => readDispatchedCommand(request)?.type === type);
}

async function waitForServerConfigToApply(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(wsRequests.some((request) => request._tag === WS_METHODS.serverGetConfig)).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );
  await waitForLayout();
}

function dispatchComposerPickerShortcut(target: EventTarget, key: "m" | "e"): void {
  const useMetaForMod = isMacPlatform(navigator.platform);
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      shiftKey: true,
      metaKey: useMetaForMod,
      ctrlKey: !useMetaForMod,
      bubbles: true,
      cancelable: true,
    }),
  );
}

function dispatchModelCycleShortcut(target: EventTarget, key: "[" | "]"): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    code: key === "]" ? "BracketRight" : "BracketLeft",
    altKey: true,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

async function dispatchModelCycleShortcutWhenReady(
  target: EventTarget,
  key: "[" | "]",
): Promise<void> {
  await vi.waitFor(
    () => {
      expect(dispatchModelCycleShortcut(target, key).defaultPrevented).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );
}

function dispatchConfiguredShortcut(
  target: EventTarget,
  input: {
    key: string;
    shiftKey?: boolean;
    altKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    modKey?: boolean;
  },
): void {
  const useMetaForMod = isMacPlatform(navigator.platform);
  const modKey = input.modKey ?? true;
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: input.key,
      shiftKey: input.shiftKey ?? false,
      altKey: input.altKey ?? false,
      metaKey: (input.metaKey ?? false) || (modKey && useMetaForMod),
      ctrlKey: (input.ctrlKey ?? false) || (modKey && !useMetaForMod),
      bubbles: true,
      cancelable: true,
    }),
  );
}

function dispatchComposerFocusToggleShortcut(): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "l",
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(event);
  return event;
}

// The composer model/effort shortcuts both drop into the same combined picker,
// rendered as a Base UI menu popup. Provider and effort detail live in lazily
// mounted submenus, so the reliable signal that the surface opened is the popup
// mounting with the active model label (the fixture pins the thread to gpt-5).
async function waitForComposerPickerSurfaceOpen(): Promise<void> {
  await vi.waitFor(() => {
    const popup = document.querySelector('[data-slot="menu-popup"]');
    expect(popup).not.toBeNull();
    expect(popup?.textContent ?? "").toContain("GPT-5");
  });
}

function dispatchChatNewShortcut(): void {
  dispatchThreadShortcut("n");
}

function dispatchAddProjectShortcut(): void {
  dispatchThreadShortcut("o", true);
}

function dispatchTerminalThreadShortcut(): void {
  dispatchThreadShortcut("t", true);
}

function dispatchThreadShortcut(key: string, shiftKey = false): void {
  const useMetaForMod = isMacPlatform(navigator.platform);
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      shiftKey,
      metaKey: useMetaForMod,
      ctrlKey: !useMetaForMod,
      bubbles: true,
      cancelable: true,
    }),
  );
}

async function triggerChatNewShortcutUntilPath(
  router: ReturnType<typeof getRouter>,
  predicate: (pathname: string) => boolean,
  errorMessage: string,
): Promise<string> {
  return triggerThreadShortcutUntilPath(router, dispatchChatNewShortcut, predicate, errorMessage);
}

async function triggerTerminalThreadShortcutUntilPath(
  router: ReturnType<typeof getRouter>,
  predicate: (pathname: string) => boolean,
  errorMessage: string,
): Promise<string> {
  return triggerThreadShortcutUntilPath(
    router,
    dispatchTerminalThreadShortcut,
    predicate,
    errorMessage,
  );
}

async function triggerThreadShortcutUntilPath(
  router: ReturnType<typeof getRouter>,
  dispatchShortcut: () => void,
  predicate: (pathname: string) => boolean,
  errorMessage: string,
): Promise<string> {
  let pathname = router.state.location.pathname;
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    dispatchShortcut();
    await waitForLayout();
    pathname = router.state.location.pathname;
    if (predicate(pathname)) {
      return pathname;
    }
  }
  throw new Error(`${errorMessage} Last path: ${pathname}`);
}

async function waitForNewThreadShortcutLabel(): Promise<void> {
  await waitForServerConfigToApply();
  await waitForComposerEditor();
  await waitForLayout();
}

async function createProjectThreadWithShortcut(
  mounted: MountedChatView,
  errorMessage = "Route should have changed to a new draft thread UUID.",
): Promise<{ path: string; threadId: ThreadId }> {
  await waitForNewThreadShortcutLabel();
  const path = await triggerChatNewShortcutUntilPath(
    mounted.router,
    (pathname) => UUID_ROUTE_RE.test(pathname),
    errorMessage,
  );
  return { path, threadId: path.slice(1) as ThreadId };
}

async function waitForImagesToLoad(scope: ParentNode): Promise<void> {
  const images = Array.from(scope.querySelectorAll("img"));
  if (images.length === 0) {
    return;
  }
  await Promise.all(
    images.map(
      (image) =>
        new Promise<void>((resolve) => {
          if (image.complete) {
            resolve();
            return;
          }
          image.addEventListener("load", () => resolve(), { once: true });
          image.addEventListener("error", () => resolve(), { once: true });
        }),
    ),
  );
  await waitForLayout();
}

async function measureChatLayout(host: HTMLElement): Promise<ChatLayoutMeasurement> {
  const scrollContainer = await waitForElement(
    () => host.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
    "Unable to find ChatView message scroll container.",
  );
  const composerForm = await waitForElement(
    () => host.querySelector<HTMLElement>("[data-chat-composer-form='true']"),
    "Unable to find chat composer form.",
  );

  await waitForLayout();

  const hostHeightPx = host.getBoundingClientRect().height;
  const composerBottomPx = composerForm.getBoundingClientRect().bottom;
  return {
    hostHeightPx,
    composerBottomPx,
    scrollClientHeightPx: scrollContainer.clientHeight,
    scrollHeightPx: scrollContainer.scrollHeight,
    distanceFromBottomPx: getScrollContainerDistanceFromBottom(scrollContainer),
  };
}

async function waitForMountedChatReady(options: {
  host: HTMLElement;
  snapshot: OrchestrationReadModel;
  routeThreadId: ThreadId;
}): Promise<void> {
  const expectedThread = options.snapshot.threads.find(
    (thread) => thread.id === options.routeThreadId,
  );

  await vi.waitFor(
    () => {
      expect(
        options.host.querySelector("[data-chat-composer-form='true']"),
        "Chat composer did not mount.",
      ).toBeTruthy();
      expect(
        wsRequests.some((request) => request._tag === WS_METHODS.serverGetConfig),
        "Browser RPC configuration did not load.",
      ).toBe(true);

      if (!expectedThread) return;
      const state = useStore.getState();
      expect(state.threadIds?.includes(expectedThread.id)).toBe(true);
      const hydratedMessageIdSet = new Set(state.messageIdsByThreadId?.[expectedThread.id] ?? []);
      expect(
        expectedThread.messages.every((message) => hydratedMessageIdSet.has(message.id)),
        "Active thread detail did not hydrate.",
      ).toBe(true);
    },
    { timeout: 20_000, interval: 16 },
  );
  await waitForLayout();
}

async function mountChatView(options: {
  viewport: ViewportSpec;
  snapshot: OrchestrationReadModel;
  configureFixture?: (fixture: TestFixture) => void;
  initialEntry?: string;
}): Promise<MountedChatView> {
  fixture = buildFixture(options.snapshot);
  options.configureFixture?.(fixture);
  await setViewport(options.viewport);
  await waitForProductionStyles();

  const host = createFullscreenTestHost();

  const initialEntry = options.initialEntry ?? `/${THREAD_ID}`;

  const router = getRouter(
    createMemoryHistory({
      initialEntries: [initialEntry],
    }),
  );
  await router.load();

  const screen = await render(<RouterProvider router={router} />, {
    container: host,
  });

  try {
    await waitForMountedChatReady({
      host,
      snapshot: options.snapshot,
      routeThreadId: ThreadId.makeUnsafe(initialEntry.slice(1)),
    });
  } catch (cause) {
    await screen.unmount();
    if (host.isConnected) host.remove();
    throw cause;
  }

  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    await screen.unmount();
    if (host.isConnected) host.remove();
  };

  return {
    [Symbol.asyncDispose]: cleanup,
    cleanup,
    measureLayout: async () => measureChatLayout(host),
    setViewport: async (viewport: ViewportSpec) => {
      await setViewport(viewport);
      await waitForProductionStyles();
    },
    router,
  };
}

describe("ChatView timeline estimator parity (full app)", () => {
  beforeAll(async () => {
    fixture = buildFixture(
      createSnapshotForTargetUser({
        targetMessageId: "msg-user-bootstrap" as MessageId,
        targetText: "bootstrap",
      }),
    );
    await worker.start({
      onUnhandledRequest: "bypass",
      quiet: true,
      serviceWorker: {
        url: "/mockServiceWorker.js",
      },
    });
  });

  afterAll(async () => {
    await resetWsNativeApiForTest();
    await worker.stop();
  });

  beforeEach(async () => {
    await resetWsNativeApiForTest();
    resetRetainedThreadDetailSubscriptionsForTests();
    await setViewport(DEFAULT_VIEWPORT);
    attachmentResponseDelayMs = 0;
    attachmentUploadSequence = 0;
    emitDomainEvent = null;
    emitSyncDomainEvent = null;
    localStorage.clear();
    useLatestProjectStore.setState({ latestFolderId: null });
    document.body.innerHTML = "";
    wsRequests.length = 0;
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByFolderId: {},
      stickyModelSelectionByProvider: {},
      stickyConnectionByProvider: {},
      stickyActiveProvider: null,
    });
    useStore.setState({ ...initialState });
    useTerminalStateStore.setState({
      terminalStateByThreadId: {},
    });
    useSplitViewStore.setState({
      splitViewsById: {},
      splitViewIdBySourceThreadId: {},
    });
    useWorkspacePathsStore.setState({
      homeDir: null,
      chatWorkspaceRoot: null,
    });
  });

  afterEach(async () => {
    resetRetainedThreadDetailSubscriptionsForTests();
    document.body.innerHTML = "";
  });

  it("truncates the Pencil header title before its controls can overlap", async () => {
    const longTitle =
      'remove "ago" from the sidebar while the Apps panel stays open on smaller viewports';
    const headerOverflowSnapshot = (() => {
      const snapshot = createSnapshotForTargetUser({
        targetMessageId: "msg-user-header-overflow-target" as MessageId,
        targetText: "header overflow",
      });

      return withProjectScripts(
        {
          ...snapshot,
          threads: snapshot.threads.map((thread) =>
            thread.id === THREAD_ID ? Object.assign({}, thread, { title: longTitle }) : thread,
          ),
        },
        [
          {
            id: "dev-server",
            name: "Dev",
            command: "bun run dev",
            icon: "play",
          },
        ],
      );
    })();
    const mounted = await mountChatView({
      viewport: { ...DEFAULT_VIEWPORT, width: 540 },
      snapshot: headerOverflowSnapshot,
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["vscode"],
        };
      },
    });

    try {
      await vi.waitFor(
        () => {
          const header = document.querySelector<HTMLElement>(
            "header[data-pencil-component='Kpx7i']",
          );
          const title = [...(header?.querySelectorAll<HTMLElement>("span") ?? [])].find(
            (candidate) => candidate.textContent === longTitle,
          );

          expect(title, "Unable to find the chat header title.").toBeTruthy();
          expect(header?.querySelector('button[aria-label="Thread menu"]')).toBeNull();

          const titleRight = title!.getBoundingClientRect().right;
          expect(titleRight).toBeLessThanOrEqual(header!.getBoundingClientRect().right + 1);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders the active thread title", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-thread-tooltip-target" as MessageId,
        targetText: "thread tooltip target",
      }),
    });

    try {
      expect(
        wsRequests.filter(
          (request) => request._tag === ORCHESTRATION_WS_METHODS.getThreadTurnsPage,
        ),
      ).toEqual([
        {
          _tag: ORCHESTRATION_WS_METHODS.getThreadTurnsPage,
          threadId: THREAD_ID,
        },
      ]);
      expect(useStore.getState().threadDetailSyncById?.[THREAD_ID]).toBe("synced");
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(THREAD_TITLE);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the composer visible while a long assistant response forces a viewport relayout", async () => {
    const mounted = await mountChatView({
      viewport: TEXT_VIEWPORT_MATRIX[0],
      snapshot: createSnapshotWithLongAssistantResponse(),
    });

    try {
      const desktopLayout = await mounted.measureLayout();
      expect(desktopLayout.scrollClientHeightPx).toBeGreaterThan(0);
      expect(desktopLayout.scrollHeightPx).toBeGreaterThan(desktopLayout.scrollClientHeightPx);
      expect(desktopLayout.composerBottomPx).toBeLessThanOrEqual(desktopLayout.hostHeightPx + 1);

      await mounted.setViewport(TEXT_VIEWPORT_MATRIX[2]);
      const mobileLayout = await mounted.measureLayout();
      expect(mobileLayout.scrollClientHeightPx).toBeGreaterThan(0);
      expect(mobileLayout.scrollHeightPx).toBeGreaterThan(mobileLayout.scrollClientHeightPx);
      expect(mobileLayout.composerBottomPx).toBeLessThanOrEqual(mobileLayout.hostHeightPx + 1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("stays pinned to the bottom after delayed attachment loads expand the timeline", async () => {
    attachmentResponseDelayMs = 160;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithBottomAttachments(),
    });

    try {
      const scrollContainer = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
        "Unable to find message scroll container.",
      );
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await waitForLayout();
      await vi.waitFor(
        () => {
          expect(document.querySelectorAll("img").length).toBeGreaterThanOrEqual(3);
        },
        { timeout: 8_000, interval: 16 },
      );
      await waitForImagesToLoad(document.body);
      await vi.waitFor(
        async () => {
          const layout = await mounted.measureLayout();
          expect(layout.scrollHeightPx).toBeGreaterThan(layout.scrollClientHeightPx);
          expect(layout.distanceFromBottomPx).toBeLessThanOrEqual(AUTO_SCROLL_BOTTOM_THRESHOLD_PX);
        },
        { timeout: 4_000, interval: 16 },
      );
    } finally {
      attachmentResponseDelayMs = 0;
      await mounted.cleanup();
    }
  });

  it("shows Thinking and smoothly re-sticks while an optimistic send awaits provider start", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-send-bottom-stick" as MessageId,
        targetText: "bottom stick target",
      }),
    });
    let patchedScrollContainer: HTMLElement | null = null;
    let originalScrollTo: HTMLElement["scrollTo"] | null = null;

    try {
      const scrollContainer = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
        "Unable to find message scroll container.",
      );
      scrollContainer.scrollTop = 0;
      // Initial tail placement ignores geometry-only scroll events because
      // ResizeObserver and the virtualizer emit those while rows settle. A
      // wheel event represents the reader intent that revokes tail ownership.
      scrollContainer.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
      scrollContainer.dispatchEvent(new Event("scroll"));
      await waitForLayout();
      expect(getScrollContainerDistanceFromBottom(scrollContainer)).toBeGreaterThan(
        AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
      );

      const scrollToCalls: ScrollToOptions[] = [];
      patchedScrollContainer = scrollContainer;
      originalScrollTo = scrollContainer.scrollTo;
      scrollContainer.scrollTo = ((options?: ScrollToOptions | number, y?: number) => {
        const normalized: ScrollToOptions =
          typeof options === "object" && options !== null
            ? options
            : {
                ...(typeof options === "number" ? { left: options } : {}),
                ...(typeof y === "number" ? { top: y } : {}),
              };
        scrollToCalls.push(normalized);
        if (typeof normalized.left === "number") {
          scrollContainer.scrollLeft = normalized.left;
        }
        if (typeof normalized.top === "number") {
          scrollContainer.scrollTop = normalized.top;
        }
        scrollContainer.dispatchEvent(new Event("scroll"));
      }) as typeof scrollContainer.scrollTo;

      const prompt = "keep me pinned after send";
      useComposerDraftStore.getState().setPrompt(THREAD_ID, prompt);

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        async () => {
          expect(document.body.textContent).toContain(prompt);
          expect(document.body.textContent).toContain("Thinking");
          expect(document.activeElement).toBe(await waitForComposerEditor());
          expect(scrollToCalls.some((call) => call.behavior === "smooth")).toBe(true);
          const layout = await mounted.measureLayout();
          expect(layout.scrollHeightPx).toBeGreaterThan(layout.scrollClientHeightPx);
          expect(layout.distanceFromBottomPx).toBeLessThanOrEqual(AUTO_SCROLL_BOTTOM_THRESHOLD_PX);
        },
        { timeout: 8_000, interval: 16 },
      );
      scrollContainer.scrollTo = originalScrollTo;
    } finally {
      if (patchedScrollContainer && originalScrollTo) {
        patchedScrollContainer.scrollTo = originalScrollTo;
      }
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  it("keeps send chrome live through durable, starting, and lagging ready snapshots", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    let currentSnapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-send-handoff-target" as MessageId,
      targetText: "send handoff target",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: currentSnapshot,
    });

    const syncActiveThread = (
      update: (
        thread: OrchestrationReadModel["threads"][number],
      ) => OrchestrationReadModel["threads"][number],
    ) => {
      currentSnapshot = {
        ...currentSnapshot,
        snapshotSequence: currentSnapshot.snapshotSequence + 1,
        threads: currentSnapshot.threads.map((thread) =>
          thread.id === THREAD_ID ? update(thread) : thread,
        ),
        updatedAt: isoAt(2_100 + currentSnapshot.snapshotSequence),
      };
      fixture = { ...fixture, snapshot: currentSnapshot };
      useStore.getState().syncServerReadModel(currentSnapshot);
    };
    const expectLiveSendChrome = async () => {
      await vi.waitFor(
        () => {
          expect(
            document.querySelector<HTMLButtonElement>('button[aria-label="Stop generation"]'),
          ).toBeTruthy();
          expect(
            document.querySelector<HTMLButtonElement>('button[aria-label="Send message"]'),
          ).toBeNull();
          expect(document.body.textContent).toContain("Thinking");
          const thinkingStatus = document.querySelector<HTMLElement>(
            '[data-timeline-row-kind="working"] > div',
          );
          expect(thinkingStatus).toBeTruthy();
          expect(getComputedStyle(thinkingStatus!).visibility).toBe("visible");
        },
        { timeout: 8_000, interval: 16 },
      );
    };

    try {
      // A canonical provider-connection projection has no optimistic local-dispatch latch. It
      // still owns both Stop and the transcript status; they must never diverge.
      syncActiveThread((thread) => ({
        ...thread,
        session: thread.session
          ? { ...thread.session, status: "starting", updatedAt: isoAt(2_100) }
          : null,
        updatedAt: isoAt(2_100),
      }));
      await expectLiveSendChrome();
      syncActiveThread((thread) => ({
        ...thread,
        session: thread.session
          ? { ...thread.session, status: "ready", updatedAt: isoAt(2_101) }
          : null,
        updatedAt: isoAt(2_101),
      }));

      const prompt = "keep working chrome continuously visible";
      useComposerDraftStore.getState().setPrompt(THREAD_ID, prompt);
      (await waitForSendButton()).click();
      await expectLiveSendChrome();

      const turnStartCommand = await vi.waitFor(() => {
        const command = wsRequests
          .map(readDispatchedCommand)
          .find((candidate) => candidate?.type === "thread.turn.start");
        expect(command).toBeTruthy();
        return command!;
      });
      const message = turnStartCommand.message as { messageId: MessageId };

      // The user-message projection arrives before turn-start ownership.
      syncActiveThread((thread) => ({
        ...thread,
        messages: [
          ...thread.messages,
          createUserMessage({ id: message.messageId, text: prompt, offsetSeconds: 2_101 }),
        ],
        updatedAt: isoAt(2_102),
      }));
      await expectLiveSendChrome();

      // The turn-start projection takes the session to starting.
      syncActiveThread((thread) => ({
        ...thread,
        pendingTurnStartMessageId: message.messageId,
        session: thread.session
          ? { ...thread.session, status: "starting", updatedAt: isoAt(2_103) }
          : null,
        updatedAt: isoAt(2_103),
      }));
      await expectLiveSendChrome();

      // A lagging shell snapshot must not reopen the idle composer seam.
      syncActiveThread((thread) => ({
        ...thread,
        pendingTurnStartMessageId: null,
        session: thread.session
          ? { ...thread.session, status: "ready", updatedAt: isoAt(2_104) }
          : null,
        updatedAt: isoAt(2_104),
      }));
      await expectLiveSendChrome();

      const turnId = TurnId.makeUnsafe("turn-send-handoff-running");
      const providerTurnId = TurnId.makeUnsafe("provider-turn-send-handoff-running");
      // The durable turn request arrives before either the provider start
      // timestamp or the session's running projection. Once local dispatch is
      // acknowledged, this exact first-turn seam must keep Thinking visible.
      syncActiveThread((thread) => ({
        ...thread,
        workStatus: "running",
        latestTurn: {
          turnId,
          providerTurnId,
          state: "running",
          requestedAt: isoAt(2_103),
          startedAt: null,
          completedAt: null,
          assistantMessageId: null,
        },
        updatedAt: isoAt(2_105),
      }));
      await expectLiveSendChrome();
      expect(document.body.textContent).not.toContain("Working for");

      syncActiveThread((thread) => ({
        ...thread,
        latestTurn: thread.latestTurn
          ? { ...thread.latestTurn, startedAt: isoAt(2_106) }
          : thread.latestTurn,
        session: thread.session
          ? {
              ...thread.session,
              status: "running",
              activeTurnId: providerTurnId,
              updatedAt: isoAt(2_106),
            }
          : null,
        updatedAt: isoAt(2_106),
      }));
      await expectLiveSendChrome();
      await vi.waitFor(() => expect(document.body.textContent).toContain("Working for"), {
        timeout: 8_000,
        interval: 16,
      });

      // The shell stream can arrive later while carrying the older ready row.
      // Its envelope sequence is new, but its per-thread session timestamp is not.
      const laggingShellReadModel: OrchestrationReadModel = {
        ...currentSnapshot,
        snapshotSequence: currentSnapshot.snapshotSequence + 1,
        threads: currentSnapshot.threads.map((thread) =>
          thread.id === THREAD_ID
            ? {
                ...thread,
                latestTurn: null,
                pendingTurnStartMessageId: null,
                session: thread.session
                  ? {
                      ...thread.session,
                      status: "ready",
                      activeTurnId: null,
                      updatedAt: isoAt(2_104),
                    }
                  : null,
                updatedAt: isoAt(2_106),
              }
            : thread,
        ),
        updatedAt: isoAt(2_106),
      };
      useStore
        .getState()
        .syncServerShellSnapshot(createShellSnapshotFromReadModel(laggingShellReadModel));
      await expectLiveSendChrome();
      expect(document.body.textContent).toContain("Working for");
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  it("settles transcript chrome despite stale shell and turn detail after session readiness", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    const staleMessageId = MessageId.makeUnsafe("msg-stale-steer-pending");
    const staleTurnId = TurnId.makeUnsafe("turn-stale-steer-completed");
    const baseSnapshot = createSnapshotForTargetUser({
      targetMessageId: staleMessageId,
      targetText: "older steered question",
    });
    const snapshot: OrchestrationReadModel = {
      ...baseSnapshot,
      threads: baseSnapshot.threads.map((thread) =>
        thread.id === THREAD_ID
          ? {
              ...thread,
              pendingTurnStartMessageId: staleMessageId,
              // Shell and latest-turn projections can lag the authoritative
              // session-ready event independently after a tool-heavy turn.
              workStatus: "running" as const,
              latestTurn: {
                turnId: staleTurnId,
                state: "running",
                requestedAt: isoAt(2_200),
                startedAt: isoAt(2_201),
                completedAt: null,
                assistantMessageId: null,
              },
              messages: thread.messages.map((message) =>
                message.id === staleMessageId
                  ? {
                      ...message,
                      dispatchMode: "steer" as const,
                      // The message-local steer marker can lag the terminal
                      // session event. It must not keep Thinking alive after
                      // the session's newer ready timestamp.
                      delivery: { state: "steering" as const, queued: false, sequence: 12 },
                    }
                  : message,
              ),
              session: thread.session
                ? {
                    ...thread.session,
                    status: "ready" as const,
                    activeTurnId: null,
                    updatedAt: isoAt(2_202),
                  }
                : null,
              updatedAt: isoAt(2_202),
            }
          : thread,
      ),
    };
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });

    try {
      expect(document.body.textContent).not.toContain("Thinking");
      expect(document.body.textContent).not.toContain("Working for");
      expect(
        document.querySelector<HTMLButtonElement>('button[aria-label="Stop generation"]'),
      ).toBeNull();

      const prompt = "send normally after the completed steer";
      useComposerDraftStore.getState().setPrompt(THREAD_ID, prompt);
      (await waitForSendButton()).click();

      const command = await vi.waitFor(() => {
        const turnStart = wsRequests
          .map(readDispatchedCommand)
          .find(
            (candidate) =>
              candidate?.type === "thread.turn.start" &&
              typeof candidate.message === "object" &&
              candidate.message !== null &&
              Reflect.get(candidate.message, "text") === prompt,
          );
        expect(turnStart).toBeTruthy();
        return turnStart!;
      });
      expect(command.dispatchMode).toBe("queue");
      expect(command.bindingRevision).toBe(0);
      expect(document.body.textContent).toContain(prompt);
      expect(
        [...document.querySelectorAll("button")].some(
          (button) => button.textContent?.trim() === "Steer",
        ),
      ).toBe(false);
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  it("sends the protocol's exact binding revision zero for an unstarted server thread", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    const withEmptyThread = addThreadToSnapshot(createDraftOnlySnapshot(), OTHER_THREAD_ID);
    const snapshot: OrchestrationReadModel = {
      ...withEmptyThread,
      threads: withEmptyThread.threads.map((thread) =>
        thread.id === OTHER_THREAD_ID ? { ...thread, session: null } : thread,
      ),
    };
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot,
      initialEntry: `/${OTHER_THREAD_ID}`,
    });

    try {
      const prompt = "start the exact-revision thread";
      useComposerDraftStore.getState().setPrompt(OTHER_THREAD_ID, prompt);
      (await waitForSendButton()).click();

      const command = await vi.waitFor(() => {
        const turnStart = wsRequests
          .map(readDispatchedCommand)
          .find(
            (candidate) =>
              candidate?.type === "thread.turn.start" && candidate.threadId === OTHER_THREAD_ID,
          );
        expect(turnStart).toBeTruthy();
        return turnStart!;
      });
      expect(command.bindingRevision).toBe(0);
      expect(command.modelSelection).toEqual(
        expect.objectContaining({ provider: "codex", model: expect.any(String) }),
      );
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  it("auto-follows real transcript changes without re-sticking for non-message activity", async () => {
    let currentSnapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-auto-follow-wiring" as MessageId,
      targetText: "auto-follow wiring target",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: currentSnapshot,
    });
    let patchedScrollContainer: HTMLElement | null = null;
    let originalScrollTo: HTMLElement["scrollTo"] | null = null;

    const syncActiveThread = (
      update: (
        thread: OrchestrationReadModel["threads"][number],
      ) => OrchestrationReadModel["threads"][number],
    ) => {
      currentSnapshot = {
        ...currentSnapshot,
        snapshotSequence: currentSnapshot.snapshotSequence + 1,
        threads: currentSnapshot.threads.map((thread) =>
          thread.id === THREAD_ID ? update(thread) : thread,
        ),
        updatedAt: isoAt(currentSnapshot.snapshotSequence + 1_200),
      };
      fixture = { ...fixture, snapshot: currentSnapshot };
      useStore.getState().syncServerReadModel(currentSnapshot);
    };

    try {
      const scrollContainer = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
        "Unable to find message scroll container.",
      );
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await waitForLayout();

      const scrollToCalls: ScrollToOptions[] = [];
      patchedScrollContainer = scrollContainer;
      originalScrollTo = scrollContainer.scrollTo;
      scrollContainer.scrollTo = ((options?: ScrollToOptions | number, y?: number) => {
        const normalized: ScrollToOptions =
          typeof options === "object" && options !== null
            ? options
            : {
                ...(typeof options === "number" ? { left: options } : {}),
                ...(typeof y === "number" ? { top: y } : {}),
              };
        scrollToCalls.push(normalized);
        if (typeof normalized.left === "number") scrollContainer.scrollLeft = normalized.left;
        if (typeof normalized.top === "number") scrollContainer.scrollTop = normalized.top;
        scrollContainer.dispatchEvent(new Event("scroll"));
      }) as typeof scrollContainer.scrollTo;
      // Let mount-time tail/image expansion retries (max 260ms) settle before
      // isolating scrolls caused by the state transitions below.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 300));
      await waitForLayout();
      scrollToCalls.length = 0;

      // Buffering/connecting state changes generic turn chrome, but does not add a
      // transcript message and therefore must not re-stick the transcript.
      syncActiveThread((thread) => ({
        ...thread,
        session: thread.session
          ? {
              ...thread.session,
              status: "starting",
              updatedAt: isoAt(1_201),
            }
          : null,
        updatedAt: isoAt(1_201),
      }));
      await waitForLayout();
      expect(scrollToCalls).toHaveLength(0);

      const activeTurnId = TurnId.makeUnsafe("turn-auto-follow-wiring");
      syncActiveThread((thread) => ({
        ...thread,
        latestTurn: {
          turnId: activeTurnId,
          state: "running",
          requestedAt: isoAt(1_202),
          startedAt: isoAt(1_203),
          completedAt: null,
          assistantMessageId: null,
        },
        session: thread.session
          ? {
              ...thread.session,
              status: "running",
              activeTurnId,
              updatedAt: isoAt(1_204),
            }
          : null,
        activities: [
          ...thread.activities,
          {
            id: EventId.makeUnsafe("activity-auto-follow-approval"),
            createdAt: isoAt(1_204),
            kind: "approval.requested",
            summary: "Command approval requested",
            tone: "approval",
            turnId: activeTurnId,
            payload: {
              requestId: "request-auto-follow",
              requestKind: "command",
              detail: "inspect the unchanged transcript tail",
            },
          },
        ],
        updatedAt: isoAt(1_204),
      }));
      await waitForLayout();
      expect(scrollToCalls).toHaveLength(0);

      syncActiveThread((thread) => ({
        ...thread,
        activities: [
          ...thread.activities,
          {
            id: EventId.makeUnsafe("activity-auto-follow-tool"),
            createdAt: isoAt(1_205),
            kind: "tool.completed",
            summary: "scroll-only tool activity",
            tone: "tool",
            turnId: activeTurnId,
            payload: {
              itemType: "dynamic_tool_call",
              toolName: "inspect-scroll-tail",
            },
          },
        ],
        updatedAt: isoAt(1_205),
      }));
      await waitForLayout();
      expect(scrollToCalls).toHaveLength(0);

      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      scrollContainer.dispatchEvent(new Event("scroll"));
      scrollToCalls.length = 0;
      const liveAssistantMessage = {
        ...createAssistantMessage({
          id: MessageId.makeUnsafe("msg-assistant-auto-follow-live"),
          text: "A real live assistant tail with enough content to overflow the viewport. ".repeat(
            80,
          ),
          offsetSeconds: 1_206,
        }),
        turnId: activeTurnId,
        streaming: true,
      };
      syncActiveThread((thread) => ({
        ...thread,
        messages: [...thread.messages, liveAssistantMessage],
        updatedAt: isoAt(1_206),
      }));
      await vi.waitFor(() => expect(scrollToCalls.length).toBeGreaterThan(0), {
        timeout: 4_000,
        interval: 16,
      });

      // A real upward gesture transfers ownership to the reader immediately,
      // even while the preceding auto-follow scroll is still inside its
      // programmatic-scroll guard. The next streamed token must not fight the
      // reader back to the live edge.
      scrollToCalls.length = 0;
      scrollContainer.dispatchEvent(
        new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -120 }),
      );
      scrollContainer.scrollTop = Math.max(
        0,
        scrollContainer.scrollHeight - scrollContainer.clientHeight - 120,
      );
      scrollContainer.dispatchEvent(new Event("scroll"));
      expect(getScrollContainerDistanceFromBottom(scrollContainer)).toBeGreaterThan(0);
      syncActiveThread((thread) => ({
        ...thread,
        messages: thread.messages.map((message) =>
          message.id === liveAssistantMessage.id
            ? {
                ...message,
                text: `${message.text} with another streamed token`,
                updatedAt: isoAt(1_207),
              }
            : message,
        ),
        updatedAt: isoAt(1_207),
      }));
      await waitForLayout();
      expect(scrollToCalls).toHaveLength(0);

      // Explicitly returning to the tail restores live-follow ownership.
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await waitForLayout();
      scrollToCalls.length = 0;
      syncActiveThread((thread) => ({
        ...thread,
        messages: thread.messages.map((message) =>
          message.id === liveAssistantMessage.id
            ? {
                ...message,
                text: `${message.text} ${"with additional streamed completion details ".repeat(24)}`,
                streaming: false,
                completedAt: isoAt(1_208),
                updatedAt: isoAt(1_208),
              }
            : message,
        ),
        updatedAt: isoAt(1_208),
      }));
      await vi.waitFor(() => expect(scrollToCalls.length).toBeGreaterThan(0), {
        timeout: 4_000,
        interval: 16,
      });
    } finally {
      if (patchedScrollContainer && originalScrollTo) {
        patchedScrollContainer.scrollTo = originalScrollTo;
      }
      await mounted.cleanup();
    }
  });

  it("names the parent folder on an empty thread", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: addThreadToSnapshot(createDraftOnlySnapshot(), THREAD_ID),
      configureFixture: (nextFixture) => {
        nextFixture.welcome = {
          ...nextFixture.welcome,
          homeDir: "/Users/tester",
          chatWorkspaceRoot: "/Users/tester/Documents/Penkra",
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      const heading = page.getByTestId("empty-landing-heading").element();
      expect(heading.textContent).toContain("Project");
      expect(heading.textContent).not.toContain("Home");
      expect(heading.querySelector('[data-pencil-node="qNEBL"]')?.textContent).toBe("Project");
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders the approved split empty-thread composer component family", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          folderId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          entryPoint: "chat",
        },
      },
      projectDraftThreadIdByFolderId: {
        [PROJECT_ID]: THREAD_ID,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
    });

    try {
      await waitForComposerEditor();
      await waitForServerConfigToApply();
      await vi.waitFor(() => {
        expect(document.querySelector('[data-pencil-component="BtaMG"]')).not.toBeNull();
        expect(document.querySelector('[data-pencil-component="chpd8"]')).not.toBeNull();
        expect(document.querySelector('[data-pencil-component="N4buaG"]')).not.toBeNull();
        const accessIcon = document.querySelector<SVGSVGElement>('[data-pencil-node="Bo845"]');
        expect(accessIcon).not.toBeNull();
        expect(accessIcon?.querySelector('[data-pencil-node="z9iYLc"]')).not.toBeNull();
        expect(accessIcon?.getAttribute("viewBox")).toBe("0 0 13.99993896484375 14");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("accepts accessibility fill in a local draft without a composer store feedback loop", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          folderId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          entryPoint: "chat",
        },
      },
      projectDraftThreadIdByFolderId: {
        [PROJECT_ID]: THREAD_ID,
      },
    });
    const consoleError = vi.spyOn(console, "error");
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
    });

    try {
      await waitForServerConfigToApply();
      const editor = page.getByTestId("composer-editor");
      await editor.fill("Run pwd, then sleep 5.");
      await expect.element(editor).toHaveTextContent("Run pwd, then sleep 5.");
      await vi.waitFor(() => {
        expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
          "Run pwd, then sleep 5.",
        );
      });
      expect(
        consoleError.mock.calls.some((call) =>
          call.some((value) => String(value).includes("Maximum update depth exceeded")),
        ),
      ).toBe(false);
    } finally {
      consoleError.mockRestore();
      await mounted.cleanup();
    }
  });

  it("accepts a new prompt after a local draft is promoted without a controlled update loop", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          folderId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          entryPoint: "chat",
        },
      },
      projectDraftThreadIdByFolderId: {
        [PROJECT_ID]: THREAD_ID,
      },
    });
    const consoleError = vi.spyOn(console, "error");
    const draftSnapshot = createDraftOnlySnapshot();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: draftSnapshot,
    });

    try {
      await waitForServerConfigToApply();
      const editor = page.getByTestId("composer-editor");
      await editor.fill("first prompt");
      await expect.element(editor).toHaveTextContent("first prompt");

      useStore.getState().syncServerReadModel(addThreadToSnapshot(draftSnapshot, THREAD_ID));
      useComposerDraftStore.getState().clearDraftThread(THREAD_ID);
      await expect.element(editor).toHaveTextContent("");

      await editor.fill("second prompt");
      await expect.element(editor).toHaveTextContent("second prompt");
      await vi.waitFor(() => {
        expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
          "second prompt",
        );
      });
      expect(
        consoleError.mock.calls.some((call) =>
          call.some((value) => String(value).includes("Maximum update depth exceeded")),
        ),
      ).toBe(false);
    } finally {
      consoleError.mockRestore();
      await mounted.cleanup();
    }
  });

  it("runs project scripts from local draft threads at the project cwd", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          folderId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          entryPoint: "chat",
        },
      },
      projectDraftThreadIdByFolderId: {
        [PROJECT_ID]: THREAD_ID,
      },
    });

    const mounted = await mountChatView({
      viewport: { ...DEFAULT_VIEWPORT, width: 1_400 },
      snapshot: withProjectScripts(createDraftOnlySnapshot(), [
        {
          id: "lint",
          name: "Lint",
          command: "bun run lint",
          icon: "lint",
        },
      ]),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "script.lint.run",
              shortcut: {
                key: "l",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: true,
                modKey: false,
              },
            },
          ],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      dispatchConfiguredShortcut(window, {
        key: "l",
        altKey: true,
        modKey: false,
      });

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) =>
              request._tag === WS_METHODS.terminalOpen && request.cwd === "/repo/project",
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.terminalOpen,
            threadId: THREAD_ID,
            cwd: "/repo/project",
            env: {
              PENKRA_PROJECT_ROOT: "/repo/project",
            },
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      await vi.waitFor(
        () => {
          const writeRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.terminalWrite,
          );
          expect(writeRequest).toMatchObject({
            _tag: WS_METHODS.terminalWrite,
            threadId: THREAD_ID,
            data: "bun run lint\r",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("toggles composer focus with Cmd+L", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-composer-focus-shortcut" as MessageId,
        targetText: "composer focus shortcut",
      }),
    });
    const focusTarget = document.createElement("button");
    focusTarget.type = "button";
    focusTarget.textContent = "Focus sink";
    document.body.appendChild(focusTarget);

    try {
      await waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      focusTarget.focus();
      expect(document.activeElement).toBe(focusTarget);

      const focusEvent = dispatchComposerFocusToggleShortcut();
      expect(focusEvent.defaultPrevented).toBe(true);
      await vi.waitFor(() => {
        expect(document.activeElement).toBe(composerEditor);
      });

      const blurEvent = dispatchComposerFocusToggleShortcut();
      expect(blurEvent.defaultPrevented).toBe(true);
      await vi.waitFor(() => {
        expect(document.activeElement).not.toBe(composerEditor);
      });
    } finally {
      focusTarget.remove();
      await mounted.cleanup();
    }
  });

  it("opens the composer model picker surface", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-model-picker-shortcut" as MessageId,
        targetText: "model picker shortcut",
      }),
    });

    try {
      const composerEditor = await waitForComposerEditor();
      await waitForServerConfigToApply();
      composerEditor.focus();
      dispatchComposerPickerShortcut(composerEditor, "m");

      await waitForComposerPickerSurfaceOpen();
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows the standalone Connection control on a new Thread", async () => {
    const base = createSnapshotForTargetUser({
      targetMessageId: "msg-user-new-thread-connection-menu" as MessageId,
      targetText: "unused bootstrap",
    });
    const snapshot: OrchestrationReadModel = {
      ...base,
      threads: base.threads.map((thread) => ({
        ...thread,
        messages: [],
        activities: [],
        latestTurn: null,
        session: null,
      })),
    };
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });

    try {
      const composerEditor = await waitForComposerEditor();
      await waitForServerConfigToApply();
      const connectionTrigger = page.getByRole("button", { name: "Change connection" });
      await expect.element(connectionTrigger).toBeVisible();
      await connectionTrigger.hover();
      await expect.element(page.getByText("personal@example.com", { exact: true })).toBeVisible();
      expect(page.getByRole("button", { name: "Change mode", exact: true }).query()).toBeNull();

      composerEditor.focus();
      dispatchComposerPickerShortcut(composerEditor, "m");

      await waitForComposerPickerSurfaceOpen();
      await expect.element(page.getByText("Connection", { exact: true })).not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps Connection selection standalone after the Thread has started", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-started-thread-connection-menu" as MessageId,
        targetText: "started thread connection menu",
      }),
    });

    try {
      const composerEditor = await waitForComposerEditor();
      await waitForServerConfigToApply();
      await expect.element(page.getByRole("button", { name: "Change connection" })).toBeVisible();
      expect(page.getByRole("button", { name: "Change mode", exact: true }).query()).toBeNull();

      composerEditor.focus();
      dispatchComposerPickerShortcut(composerEditor, "m");

      await waitForComposerPickerSurfaceOpen();
      await expect.element(page.getByText("Connection", { exact: true })).not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("sends a new Thread through the last Connection saved in the composer", async () => {
    const base = createSnapshotForTargetUser({
      targetMessageId: "msg-user-default-connection-bootstrap" as MessageId,
      targetText: "unused bootstrap",
    });
    const snapshot: OrchestrationReadModel = {
      ...base,
      threads: base.threads.map((thread) => ({
        ...thread,
        messages: [],
        activities: [],
        latestTurn: null,
        session: null,
      })),
    };
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    const restoreNativeApi = installDeterministicSendNativeApi();

    try {
      await vi.waitFor(() => {
        expect(
          wsRequests.some((request) => request._tag === WS_METHODS.providerGetConnections),
        ).toBe(true);
      });
      useComposerDraftStore.setState({
        stickyConnectionByProvider: { codex: TEST_CONNECTION_ID },
      });
      useComposerDraftStore.getState().setPrompt(THREAD_ID, "use the saved connection");
      const composerForm = await waitForElement(
        () => document.querySelector<HTMLFormElement>('form[data-chat-composer-form="true"]'),
        "Unable to find composer form.",
      );
      composerForm.requestSubmit();

      await vi.waitFor(
        () => {
          const command = wsRequests
            .map(readDispatchedCommand)
            .find(
              (candidate) =>
                candidate?.type === "thread.turn.start" &&
                candidate.threadId === THREAD_ID &&
                typeof candidate.message === "object" &&
                candidate.message !== null &&
                "text" in candidate.message &&
                candidate.message.text === "use the saved connection",
            );
          expect(command).toMatchObject({
            type: "thread.turn.start",
            connectionId: TEST_CONNECTION_ID,
          });
          expect(document.body.textContent).not.toContain(
            "Choose a Connection before sending this message.",
          );
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  it("chooses the first available Connection when the composer has no saved choice", async () => {
    const base = createSnapshotForTargetUser({
      targetMessageId: "msg-user-server-default-connection" as MessageId,
      targetText: "unused bootstrap",
    });
    const snapshot: OrchestrationReadModel = {
      ...base,
      threads: base.threads.map((thread) => ({
        ...thread,
        messages: [],
        activities: [],
        latestTurn: null,
        session: null,
      })),
    };
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    const restoreNativeApi = installDeterministicSendNativeApi();

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_ID, "use the first connection");
      const composerForm = await waitForElement(
        () => document.querySelector<HTMLFormElement>('form[data-chat-composer-form="true"]'),
        "Unable to find composer form.",
      );
      composerForm.requestSubmit();

      await vi.waitFor(
        () => {
          const command = wsRequests
            .map(readDispatchedCommand)
            .find(
              (candidate) =>
                candidate?.type === "thread.turn.start" && candidate.threadId === THREAD_ID,
            );
          expect(command).toMatchObject({
            type: "thread.turn.start",
            connectionId: TEST_CONNECTION_ID,
          });
          expect(document.body.textContent).not.toContain(
            "Choose a Connection before sending this message.",
          );
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  it("cycles the active provider model without opening the picker", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-model-cycle-shortcut" as MessageId,
        targetText: "model cycle shortcut",
      }),
    });

    try {
      await waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();

      await dispatchModelCycleShortcutWhenReady(composerEditor, "]");
      await vi.waitFor(() => {
        expect(
          useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.modelSelectionByProvider
            .codex,
        ).toMatchObject({ provider: "codex", model: "gpt-5.5" });
      });
      expect(document.querySelector('[data-slot="menu-popup"]')).toBeNull();

      await dispatchModelCycleShortcutWhenReady(composerEditor, "[");
      await vi.waitFor(() => {
        expect(
          useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.modelSelectionByProvider
            .codex,
        ).toMatchObject({ provider: "codex", model: "gpt-5.2" });
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the composer model picker with configured keybinding labels loaded", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-model-picker-configured-shortcut" as MessageId,
        targetText: "configured model picker shortcut",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "modelPicker.toggle",
              shortcut: {
                key: "m",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: true,
                modKey: true,
              },
            },
          ],
        };
      },
    });

    try {
      const composerEditor = await waitForComposerEditor();
      await waitForServerConfigToApply();
      composerEditor.focus();
      dispatchConfiguredShortcut(composerEditor, { key: "m", altKey: true });

      await waitForComposerPickerSurfaceOpen();
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the composer effort picker surface", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-effort-picker-shortcut" as MessageId,
        targetText: "effort picker shortcut",
      }),
    });

    try {
      const composerEditor = await waitForComposerEditor();
      await waitForServerConfigToApply();
      composerEditor.focus();
      dispatchComposerPickerShortcut(composerEditor, "e");

      await waitForComposerPickerSurfaceOpen();
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps removed terminal context pills removed when a new one is added", async () => {
    const removedLabel = "Terminal 1 lines 1-2";
    const addedLabel = "Terminal 2 lines 9-10";
    useComposerDraftStore.getState().addTerminalContext(
      THREAD_ID,
      createTerminalContext({
        id: "ctx-removed",
        terminalLabel: "Terminal 1",
        lineStart: 1,
        lineEnd: 2,
        text: "bun i\nno changes",
      }),
    );

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-terminal-pill-backspace" as MessageId,
        targetText: "terminal pill backspace target",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(removedLabel);
        },
        { timeout: 8_000, interval: 16 },
      );

      const store = useComposerDraftStore.getState();
      const currentPrompt = store.draftsByThreadId[THREAD_ID]?.prompt ?? "";
      const nextPrompt = removeInlineTerminalContextPlaceholder(currentPrompt, 0);
      store.setPrompt(THREAD_ID, nextPrompt.prompt);
      store.removeTerminalContext(THREAD_ID, "ctx-removed");

      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]).toBeUndefined();
          expect(document.body.textContent).not.toContain(removedLabel);
        },
        { timeout: 8_000, interval: 16 },
      );

      useComposerDraftStore.getState().addTerminalContext(
        THREAD_ID,
        createTerminalContext({
          id: "ctx-added",
          terminalLabel: "Terminal 2",
          lineStart: 9,
          lineEnd: 10,
          text: "git status\nOn branch main",
        }),
      );

      await vi.waitFor(
        () => {
          const draft = useComposerDraftStore.getState().draftsByThreadId[THREAD_ID];
          expect(draft?.terminalContexts.map((context) => context.id)).toEqual(["ctx-added"]);
          expect(document.body.textContent).toContain(addedLabel);
          expect(document.body.textContent).not.toContain(removedLabel);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("disables send when the composer only contains an expired terminal pill", async () => {
    const expiredLabel = "Terminal 1 line 4";
    useComposerDraftStore.getState().addTerminalContext(
      THREAD_ID,
      createTerminalContext({
        id: "ctx-expired-only",
        terminalLabel: "Terminal 1",
        lineStart: 4,
        lineEnd: 4,
        text: "",
      }),
    );

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-expired-pill-disabled" as MessageId,
        targetText: "expired pill disabled target",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(expiredLabel);
        },
        { timeout: 8_000, interval: 16 },
      );

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(true);
    } finally {
      await mounted.cleanup();
    }
  });

  it("warns when sending text while omitting expired terminal pills", async () => {
    const expiredLabel = "Terminal 1 line 4";
    useComposerDraftStore.getState().addTerminalContext(
      THREAD_ID,
      createTerminalContext({
        id: "ctx-expired-send-warning",
        terminalLabel: "Terminal 1",
        lineStart: 4,
        lineEnd: 4,
        text: "",
      }),
    );
    useComposerDraftStore
      .getState()
      .setPrompt(THREAD_ID, `yoo${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}waddup`);

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-expired-pill-warning" as MessageId,
        targetText: "expired pill warning target",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(expiredLabel);
        },
        { timeout: 8_000, interval: 16 },
      );

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(
            "Expired terminal context omitted from message",
          );
          expect(document.body.textContent).not.toContain(expiredLabel);
          expect(document.body.textContent).toContain("yoowaddup");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps voice input beside the running stop button", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-stop-button-cursor" as MessageId,
        targetText: "stop button cursor target",
        sessionStatus: "running",
      }),
    });

    try {
      const stopButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Stop generation"]'),
        "Unable to find stop generation button.",
      );
      const voiceButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Voice input"]'),
        "Unable to find voice input beside the running stop button.",
      );

      expect(getComputedStyle(stopButton).cursor).toBe("pointer");
      expect(voiceButton.disabled).toBe(false);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the voice-note send button at the trailing edge while recording a running turn", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-recording-running-turn" as MessageId,
        targetText: "recording during a running turn",
        sessionStatus: "running",
      }),
    });

    try {
      useVoiceSessionCoordinatorStore.setState({
        capture: {
          origin: {
            threadId: THREAD_ID,
            providerThreadId: null,
            cwd: "/tmp/penkra-browser-test",
          },
          phase: "recording",
          startedAtMs: performance.now(),
          durationMs: 4_000,
          waveformLevels: [0.2, 0.6, 0.4],
        },
      });

      const sendVoiceButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Send voice note"]'),
        "Unable to find the send voice note button.",
      );
      const actions = sendVoiceButton.closest<HTMLElement>("[data-pencil-component='JwTiI']");

      expect(actions).not.toBeNull();
      expect(document.querySelector('button[aria-label="Stop generation"]')).toBeNull();
      expect(sendVoiceButton.dataset.pencilComponent).toBe("eFqUm");
      expect(
        actions!.getBoundingClientRect().right - sendVoiceButton.getBoundingClientRect().right,
      ).toBeCloseTo(0, 0);
    } finally {
      useVoiceSessionCoordinatorStore.setState({ capture: null });
      await mounted.cleanup();
    }
  });

  it("queues follow-ups durably while a turn is starting and still cancels the starting turn", async () => {
    const pendingMessageId = "msg-user-starting-cancellable" as MessageId;
    const spaceId = SpaceId.makeUnsafe("space-starting-cancellable");
    const startingSnapshot = createSnapshotForTargetUser({
      targetMessageId: pendingMessageId,
      targetText: "pending provider start prompt",
      sessionStatus: "starting",
    });
    const hydratedStartingSnapshot: OrchestrationReadModel = {
      ...startingSnapshot,
      spaces: [
        {
          id: spaceId,
          name: "Starting cancellation",
          icon: "bag",
          sortOrder: 0,
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
          archivedAt: null,
          deletedAt: null,
        },
      ],
      folders: startingSnapshot.folders.map((project) => ({
        ...project,
        spaceId,
      })),
      threads: startingSnapshot.threads.map((thread) =>
        thread.id === THREAD_ID
          ? {
              ...thread,
              spaceId,
              pendingTurnStartMessageId: pendingMessageId,
              messages: thread.messages.map((message) =>
                message.id === pendingMessageId
                  ? {
                      ...message,
                      delivery: { state: "starting" as const, queued: false, sequence: 10 },
                      sequence: 10,
                    }
                  : message,
              ),
            }
          : thread,
      ),
    };
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: hydratedStartingSnapshot,
    });

    try {
      const composerEditor = await waitForComposerEditor();
      expect(composerEditor.getAttribute("contenteditable")).toBe("true");
      expect(document.body.textContent).toContain("Thinking");

      useComposerDraftStore.getState().setPrompt(THREAD_ID, "follow-up typed during startup");
      const composerForm = await waitForElement(
        () => document.querySelector<HTMLFormElement>('form[data-chat-composer-form="true"]'),
        "Unable to find composer form.",
      );
      composerForm.requestSubmit();
      await vi.waitFor(
        () => {
          const queuedTurn = wsRequests
            .map(readDispatchedCommand)
            .find(
              (command) =>
                command?.type === "thread.turn.start" &&
                command.dispatchMode === "queue" &&
                typeof command.message === "object" &&
                command.message !== null &&
                "text" in command.message &&
                command.message.text === "follow-up typed during startup",
            );
          expect(queuedTurn).toBeTruthy();
          expect(
            useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.queuedTurns[0]
              ?.serverAcceptedAt,
          ).toBeTruthy();
          expect(document.body.textContent).toContain("follow-up typed during startup");
          expect(document.body.textContent).toContain("Steer");
        },
        { timeout: 8_000, interval: 16 },
      );

      const stopButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Stop generation"]'),
        "Unable to find stop generation button during startup.",
      );
      stopButton.click();

      await vi.waitFor(
        () => {
          const interrupt = wsRequests
            .map(readDispatchedCommand)
            .find((command) => command?.type === "thread.turn.interrupt");
          expect(interrupt?.pendingMessageId).toBe(pendingMessageId);
          expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt ?? "").toBe(
            "pending provider start prompt",
          );
        },
        { timeout: 8_000, interval: 16 },
      );

      expect(emitSyncDomainEvent).not.toBeNull();
      emitSyncDomainEvent!(
        makeDomainEvent(
          "thread.turn-start-cancelled",
          {
            threadId: THREAD_ID,
            messageId: pendingMessageId,
            cancelledAt: NOW_ISO,
          },
          { sequence: 11 },
        ),
      );

      await vi.waitFor(
        () => {
          const draft = useComposerDraftStore.getState().draftsByThreadId[THREAD_ID];
          expect(draft?.prompt).toBe("pending provider start prompt");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows a durable queued row while submitting a running-turn follow-up", async () => {
    const consoleError = vi.spyOn(console, "error");
    let currentSnapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-running-queue-button" as MessageId,
      targetText: "running queue button target",
      sessionStatus: "running",
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: currentSnapshot,
    });

    try {
      const composerEditor = await waitForComposerEditor();
      await page.getByTestId("composer-editor").fill("queue this follow-up");
      await expect
        .element(page.getByTestId("composer-editor"))
        .toHaveTextContent("queue this follow-up");
      const composerForm = await waitForElement(
        () => document.querySelector<HTMLFormElement>('form[data-chat-composer-form="true"]'),
        "Unable to find composer form.",
      );
      composerForm.requestSubmit();

      await vi.waitFor(
        () => {
          const turnStart = wsRequests
            .map(readDispatchedCommand)
            .find(
              (command) =>
                command?.type === "thread.turn.start" &&
                command.dispatchMode === "queue" &&
                typeof command.message === "object" &&
                command.message !== null &&
                "text" in command.message &&
                typeof command.message.text === "string" &&
                command.message.text.includes("queue this follow-up"),
            );
          expect(turnStart).toBeTruthy();
          expect(
            useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.queuedTurns[0]
              ?.serverAcceptedAt,
          ).toBeTruthy();
          expect(document.querySelector('[data-testid="queued-follow-up-row"]')).not.toBeNull();
          expect(document.body.textContent).toContain("Steer");
          expect(composerEditor.textContent).toBe("");
        },
        { timeout: 8_000, interval: 16 },
      );

      const queuedCommand = wsRequests
        .map(readDispatchedCommand)
        .find(
          (command) =>
            command?.type === "thread.turn.start" &&
            typeof command.message === "object" &&
            command.message !== null &&
            "messageId" in command.message,
        );
      const queuedMessageId = (queuedCommand?.message as { messageId: MessageId }).messageId;
      currentSnapshot = {
        ...currentSnapshot,
        snapshotSequence: currentSnapshot.snapshotSequence + 1,
        threads: currentSnapshot.threads.map((thread) =>
          thread.id === THREAD_ID
            ? {
                ...thread,
                queuedMessageIds: [queuedMessageId],
                messages: [
                  ...thread.messages,
                  {
                    id: queuedMessageId,
                    role: "user" as const,
                    text: "queue this follow-up",
                    dispatchMode: "queue" as const,
                    delivery: { state: "queued" as const, queued: true, sequence: 200 },
                    turnId: null,
                    streaming: false,
                    source: "native" as const,
                    createdAt: NOW_ISO,
                    updatedAt: NOW_ISO,
                  },
                ],
              }
            : thread,
        ),
      };
      fixture = { ...fixture, snapshot: currentSnapshot };
      useStore.getState().syncServerReadModel(currentSnapshot);
      await vi.waitFor(() => {
        expect(document.querySelector(`[data-message-id="${queuedMessageId}"]`)).toBeNull();
        expect(document.querySelector('[data-testid="queued-follow-up-row"]')).not.toBeNull();
      });

      const steerButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
            (button) => button.textContent?.trim() === "Steer",
          ) ?? null,
        "Unable to find queued Steer button.",
      );
      steerButton.click();
      await vi.waitFor(
        () => {
          expect(
            wsRequests
              .map(readDispatchedCommand)
              .some((command) => command?.type === "thread.turn.steer-queued"),
          ).toBe(true);
          // The user's action owns placement immediately: clear the queue row
          // and show the same durable message once in the transcript while the
          // provider handoff continues in the background.
          expect(document.querySelector('[data-testid="queued-follow-up-row"]')).toBeNull();
          expect(document.querySelectorAll(`[data-message-id="${queuedMessageId}"]`)).toHaveLength(
            1,
          );
        },
        { timeout: 8_000, interval: 16 },
      );

      currentSnapshot = {
        ...currentSnapshot,
        snapshotSequence: currentSnapshot.snapshotSequence + 1,
        threads: currentSnapshot.threads.map((thread) =>
          thread.id === THREAD_ID
            ? {
                ...thread,
                queuedMessageIds: [],
                messages: thread.messages.map((message) =>
                  message.id === queuedMessageId
                    ? {
                        ...message,
                        delivery: { state: "accepted" as const, queued: true, sequence: 201 },
                      }
                    : message,
                ),
              }
            : thread,
        ),
      };
      useStore.getState().syncServerReadModel(currentSnapshot);
      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="queued-follow-up-row"]')).toBeNull();
        expect(document.querySelectorAll(`[data-message-id="${queuedMessageId}"]`)).toHaveLength(1);
      });

      const stopButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Stop generation"]'),
        "Unable to find stop generation button.",
      );
      expect(stopButton).not.toBeNull();
      expect(
        consoleError.mock.calls.some((call) =>
          call.some((value) => String(value).includes("Maximum update depth exceeded")),
        ),
      ).toBe(false);
    } finally {
      consoleError.mockRestore();
      await mounted.cleanup();
    }
  });

  it("coalesces bulk editor input without corrupting text or nesting React updates", async () => {
    const consoleError = vi.spyOn(console, "error");
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-bulk-composer-input" as MessageId,
        targetText: "bulk composer input target",
      }),
    });

    try {
      const composerEditor = await waitForComposerEditor();
      const bulkPrompt = Array.from(
        { length: 8 },
        (_, index) =>
          `Item ${index + 1} covers architecture workflows performance reliability and testing.`,
      ).join(" ");
      await userEvent.type(composerEditor, bulkPrompt);

      await vi.waitFor(
        () => {
          expect(composerEditor.textContent).toBe(bulkPrompt);
          expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
            bulkPrompt,
          );
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(
        consoleError.mock.calls.some((call) =>
          call.some((value) => String(value).includes("Maximum update depth exceeded")),
        ),
      ).toBe(false);
    } finally {
      consoleError.mockRestore();
      await mounted.cleanup();
    }
  });

  it("reveals a promoted queued follow-up after the assistant response it waited behind", async () => {
    const queuedMessageId = "msg-queued-after-assistant" as MessageId;
    const assistantMessageId = "msg-assistant-before-queued" as MessageId;
    const queuedTurnId = "turn-promoted-queued" as TurnId;
    const firstTurnId = "turn-before-promoted-queue" as TurnId;
    const base = createSnapshotForTargetUser({
      targetMessageId: "msg-user-before-queue" as MessageId,
      targetText: "Hey, what can you do?",
      sessionStatus: "running",
    });
    const snapshot: OrchestrationReadModel = {
      ...base,
      threads: base.threads.map((thread) =>
        thread.id === THREAD_ID
          ? {
              ...thread,
              queuedMessageIds: [queuedMessageId],
              messages: [
                ...thread.messages
                  .filter((message) => message.id === ("msg-user-before-queue" as MessageId))
                  .map((message) => ({
                    ...message,
                    sequence: 1,
                    turnId: firstTurnId,
                  })),
                // Admitted before the provider produced visible assistant text.
                // It remains hidden in the queue until sequence 5 promotes it.
                {
                  id: queuedMessageId,
                  role: "user" as const,
                  text: "Ground yourself",
                  dispatchMode: "queue" as const,
                  delivery: { state: "queued" as const, queued: true, sequence: 2 },
                  sequence: 2,
                  turnId: queuedTurnId,
                  streaming: false,
                  source: "native" as const,
                  createdAt: isoAt(1_002),
                  updatedAt: isoAt(1_002),
                },
                {
                  id: assistantMessageId,
                  role: "assistant" as const,
                  text: "Quite a lot. I can help with code and research.",
                  sequence: 3,
                  turnId: firstTurnId,
                  streaming: false,
                  source: "native" as const,
                  createdAt: isoAt(1_003),
                  updatedAt: isoAt(1_004),
                },
              ],
            }
          : thread,
      ),
    };
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });

    try {
      await vi.waitFor(() => {
        expect(document.querySelector(`[data-message-id="${queuedMessageId}"]`)).toBeNull();
        expect(document.querySelector(`[data-message-id="${assistantMessageId}"]`)).not.toBeNull();
        expect(
          document.querySelector('[data-testid="queued-follow-up-row"]')?.textContent,
        ).toContain("Ground yourself");
        expect(
          useStore.getState().messageByThreadId?.[THREAD_ID]?.[assistantMessageId]?.sequence,
        ).toBe(3);
      });

      expect(emitSyncDomainEvent).not.toBeNull();
      emitSyncDomainEvent!(
        makeDomainEvent(
          "thread.turn-start-requested",
          {
            threadId: THREAD_ID,
            turnId: queuedTurnId,
            messageId: queuedMessageId,
            dispatchMode: "queue",
            runtimeMode: "full-access",
            createdAt: isoAt(1_002),
          },
          { sequence: 5 },
        ),
      );

      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="queued-follow-up-row"]')).toBeNull();
        expect(useStore.getState().messageIdsByThreadId?.[THREAD_ID]).toEqual([
          "msg-user-before-queue" as MessageId,
          assistantMessageId,
          queuedMessageId,
        ]);
        const transcriptMessageIds = Array.from(
          document.querySelectorAll<HTMLElement>("[data-message-id]"),
        ).map((element) => element.dataset.messageId);
        expect(transcriptMessageIds.indexOf(assistantMessageId)).toBeGreaterThanOrEqual(0);
        expect(transcriptMessageIds.indexOf(queuedMessageId)).toBeGreaterThan(
          transcriptMessageIds.indexOf(assistantMessageId),
        );
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("hydrates an already promoted queued follow-up after the assistant response", async () => {
    const queuedMessageId = "msg-hydrated-queued-after-assistant" as MessageId;
    const assistantMessageId = "msg-hydrated-assistant-before-queued" as MessageId;
    const queuedTurnId = "turn-hydrated-promoted-queued" as TurnId;
    const firstTurnId = "turn-hydrated-before-promoted-queue" as TurnId;
    const base = createSnapshotForTargetUser({
      targetMessageId: "msg-hydrated-user-before-queue" as MessageId,
      targetText: "Hey, what can you do?",
      sessionStatus: "ready",
    });
    const snapshot: OrchestrationReadModel = {
      ...base,
      threads: base.threads.map((thread) =>
        thread.id === THREAD_ID
          ? {
              ...thread,
              queuedMessageIds: [],
              messages: [
                ...thread.messages
                  .filter(
                    (message) => message.id === ("msg-hydrated-user-before-queue" as MessageId),
                  )
                  .map((message) => ({ ...message, sequence: 29_718, turnId: firstTurnId })),
                // This is the exact durable projection shape: admitted before
                // the assistant, accepted only after that response completed.
                {
                  id: queuedMessageId,
                  role: "user" as const,
                  text: "Ground yourself",
                  dispatchMode: "queue" as const,
                  delivery: { state: "accepted" as const, queued: true, sequence: 29_857 },
                  sequence: 29_724,
                  turnId: queuedTurnId,
                  streaming: false,
                  source: "native" as const,
                  createdAt: isoAt(1_002),
                  updatedAt: isoAt(1_005),
                },
                {
                  id: assistantMessageId,
                  role: "assistant" as const,
                  text: "Quite a lot. I can help with code and research.",
                  sequence: 29_726,
                  turnId: firstTurnId,
                  streaming: false,
                  source: "native" as const,
                  createdAt: isoAt(1_003),
                  updatedAt: isoAt(1_004),
                },
              ],
            }
          : thread,
      ),
    };
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });

    try {
      await vi.waitFor(() => {
        const transcriptMessageIds = Array.from(
          document.querySelectorAll<HTMLElement>("[data-message-id]"),
        ).map((element) => element.dataset.messageId);
        expect(transcriptMessageIds.indexOf(assistantMessageId)).toBeGreaterThanOrEqual(0);
        expect(transcriptMessageIds.indexOf(queuedMessageId)).toBeGreaterThan(
          transcriptMessageIds.indexOf(assistantMessageId),
        );
        expect(document.querySelector('[data-testid="queued-follow-up-row"]')).toBeNull();
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("restores a server-authoritative queued row without duplicating it in the transcript", async () => {
    const queuedMessageId = "msg-server-authoritative-queue" as MessageId;
    const base = createSnapshotForTargetUser({
      targetMessageId: "msg-user-running-server-queue" as MessageId,
      targetText: "running server queue target",
      sessionStatus: "running",
    });
    const snapshot: OrchestrationReadModel = {
      ...base,
      threads: base.threads.map((thread) =>
        thread.id === THREAD_ID
          ? {
              ...thread,
              queuedMessageIds: [queuedMessageId],
              messages: [
                ...thread.messages,
                {
                  id: queuedMessageId,
                  role: "user" as const,
                  text: "restored durable queue item",
                  dispatchMode: "queue" as const,
                  delivery: { state: "queued" as const, queued: true, sequence: 200 },
                  sequence: 200,
                  turnId: null,
                  streaming: false,
                  source: "native" as const,
                  createdAt: NOW_ISO,
                  updatedAt: NOW_ISO,
                },
              ],
            }
          : thread,
      ),
    };
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });

    try {
      await vi.waitFor(
        () => {
          const queuedRow = document.querySelector<HTMLElement>(
            '[data-testid="queued-follow-up-row"]',
          );
          expect(queuedRow?.textContent ?? "").toContain("restored durable queue item");
          expect(queuedRow?.textContent ?? "").toContain("Steer");
          expect(document.querySelector(`[data-message-id="${queuedMessageId}"]`)).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("removes a server-authoritative queued row immediately when editing it", async () => {
    const queuedMessageId = "msg-server-authoritative-edit" as MessageId;
    const queuedPrompt = "edit this durable queued prompt";
    const base = createSnapshotForTargetUser({
      targetMessageId: "msg-user-running-server-edit" as MessageId,
      targetText: "running server edit target",
      sessionStatus: "running",
    });
    const snapshot: OrchestrationReadModel = {
      ...base,
      threads: base.threads.map((thread) =>
        thread.id === THREAD_ID
          ? {
              ...thread,
              queuedMessageIds: [queuedMessageId],
              messages: [
                ...thread.messages,
                {
                  id: queuedMessageId,
                  role: "user" as const,
                  text: queuedPrompt,
                  dispatchMode: "queue" as const,
                  delivery: { state: "queued" as const, queued: true, sequence: 200 },
                  turnId: null,
                  streaming: false,
                  source: "native" as const,
                  createdAt: NOW_ISO,
                  updatedAt: NOW_ISO,
                },
              ],
            }
          : thread,
      ),
    };
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });

    try {
      const actionsButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(
            'button[aria-label="Queued follow-up actions"]',
          ),
        "Unable to find queued actions button.",
      );
      actionsButton.click();
      const editMenuItem = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[data-slot="menu-item"]')).find(
            (item) => item.textContent?.trim() === "Edit queued prompt",
          ) ?? null,
        "Unable to find edit queued prompt menu item.",
      );
      editMenuItem.click();

      await vi.waitFor(() => {
        expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
          queuedPrompt,
        );
        expect(
          wsRequests
            .map(readDispatchedCommand)
            .some((command) => command?.type === "thread.turn.cancel-queued"),
        ).toBe(true);
      });
      expect(document.querySelector('[data-testid="queued-follow-up-row"]')).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("sends an OpenCode free-model turn with the exact anonymous route", async () => {
    const base = createSnapshotForTargetUser({
      targetMessageId: "msg-user-opencode-free-bootstrap" as MessageId,
      targetText: "unused bootstrap",
    });
    const snapshot: OrchestrationReadModel = {
      ...base,
      folders: base.folders.map((project) => ({
        ...project,
        defaultModelSelection: {
          provider: "opencode",
          model: "opencode/deepseek-v4-flash-free",
        },
      })),
      threads: base.threads.map((thread) => ({
        ...thread,
        modelSelection: {
          provider: "opencode",
          model: "opencode/deepseek-v4-flash-free",
        },
        messages: [],
        activities: [],
        latestTurn: null,
        session: null,
      })),
    };
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    const restoreNativeApi = installDeterministicSendNativeApi();

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_ID, "use the free model");
      const composerForm = await waitForElement(
        () => document.querySelector<HTMLFormElement>('form[data-chat-composer-form="true"]'),
        "Unable to find composer form.",
      );
      composerForm.requestSubmit();

      await vi.waitFor(
        () => {
          const command = wsRequests
            .map(readDispatchedCommand)
            .find(
              (candidate) =>
                candidate?.type === "thread.turn.start" &&
                candidate.threadId === THREAD_ID &&
                typeof candidate.message === "object" &&
                candidate.message !== null &&
                "text" in candidate.message &&
                candidate.message.text === "use the free model",
            );
          expect(command).toMatchObject({
            type: "thread.turn.start",
            connectionId: null,
            modelSelection: {
              provider: "opencode",
              model: "opencode/deepseek-v4-flash-free",
            },
          });
          expect(document.body.textContent).not.toContain(
            "Choose a Connection before sending this message.",
          );
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  it("steers a running turn immediately with the platform modifier", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_ID, "steer this running turn");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-running-steer-setting" as MessageId,
        targetText: "running steer setting target",
        sessionStatus: "running",
      }),
    });

    try {
      const composerEditor = await waitForComposerEditor();
      const useMetaForMod = isMacPlatform(navigator.platform);
      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          metaKey: useMetaForMod,
          ctrlKey: !useMetaForMod,
          bubbles: true,
          cancelable: true,
        }),
      );

      await vi.waitFor(
        () => {
          const turnStarts = wsRequests
            .map(readDispatchedCommand)
            .filter(
              (command) =>
                command?.type === "thread.turn.start" &&
                typeof command.message === "object" &&
                command.message !== null &&
                "text" in command.message &&
                typeof command.message.text === "string" &&
                command.message.text.includes("steer this running turn"),
            );
          expect(turnStarts).toHaveLength(1);
          expect(turnStarts[0]?.dispatchMode).toBe("steer");
          expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt ?? "").toBe(
            "",
          );
          expect(composerEditor.textContent).toBe("");
          expect(document.querySelector('[data-testid="queued-follow-up-row"]')).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("submits queued follow-ups before switching threads so returning is unnecessary", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_ID, "queue survives thread switch");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: addThreadToSnapshot(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-running-queue-switch" as MessageId,
          targetText: "running queue switch target",
          sessionStatus: "running",
        }),
        OTHER_THREAD_ID,
      ),
    });
    try {
      const composerForm = await waitForElement(
        () => document.querySelector<HTMLFormElement>('form[data-chat-composer-form="true"]'),
        "Unable to find composer form.",
      );
      composerForm.requestSubmit();

      await vi.waitFor(
        () => {
          const queuedTurn = wsRequests
            .map(readDispatchedCommand)
            .find(
              (command) =>
                command?.type === "thread.turn.start" &&
                command.dispatchMode === "queue" &&
                typeof command.message === "object" &&
                command.message !== null &&
                "text" in command.message &&
                command.message.text === "queue survives thread switch",
            );
          expect(queuedTurn).toBeTruthy();
          expect(
            useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.queuedTurns[0]
              ?.serverAcceptedAt,
          ).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );

      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: OTHER_THREAD_ID },
      });
      await waitForLayout();

      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.pathname).toBe(`/${OTHER_THREAD_ID}`);
          expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(0);
        },
        { timeout: 8_000, interval: 16 },
      );

      const matchingQueueCommands = wsRequests
        .map(readDispatchedCommand)
        .filter(
          (command) =>
            command?.type === "thread.turn.start" &&
            command.dispatchMode === "queue" &&
            typeof command.message === "object" &&
            command.message !== null &&
            "text" in command.message &&
            command.message.text === "queue survives thread switch",
        );
      expect(matchingQueueCommands).toHaveLength(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("switches threads repeatedly through real pointer clicks without starting a drag", async () => {
    const otherThreadTitle = "Pointer navigation target";
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: addThreadToSnapshot(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-pointer-navigation" as MessageId,
          targetText: "pointer navigation target",
        }),
        OTHER_THREAD_ID,
        { title: otherThreadTitle },
      ),
    });
    try {
      const targets = [
        { id: OTHER_THREAD_ID, title: otherThreadTitle },
        { id: THREAD_ID, title: THREAD_TITLE },
      ] as const;

      for (let index = 0; index < 8; index += 1) {
        const target = targets[index % targets.length]!;
        await page.getByRole("button", { name: target.title, exact: true }).click();
        await vi.waitFor(
          () => {
            expect(mounted.router.state.location.pathname).toBe(`/${target.id}`);
            expect(document.querySelector('[data-sidebar-drag-overlay="true"]')).toBeNull();
            expect(document.body.textContent).not.toContain("Something went wrong");
          },
          { timeout: 8_000, interval: 16 },
        );
      }
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps React ownership of sidebar rows through a real pointer drag", async () => {
    const otherThreadTitle = "Pointer drag target";
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: addThreadToSnapshot(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-pointer-drag" as MessageId,
          targetText: "pointer drag target",
        }),
        OTHER_THREAD_ID,
        { title: otherThreadTitle },
      ),
    });
    try {
      const source = page.getByRole("button", { name: otherThreadTitle, exact: true });
      const target = page.getByRole("button", { name: THREAD_TITLE, exact: true });

      await dragWithPointerFrames(
        source.element(),
        target.element(),
        0.25,
        () => {
          expect(document.querySelector("[data-sidebar-drop-preview]")).not.toBeNull();
        },
        "cancel",
      );
      await vi.waitFor(() => {
        expect(document.querySelector("[data-sidebar-drop-preview]")).toBeNull();
        expect(
          wsRequests
            .map(readDispatchedCommand)
            .filter((command) => command?.type === "sidebar.item.move"),
        ).toHaveLength(0);
      });
      await waitForLayout();

      await dragWithPointerFrames(source.element(), target.element(), 0.25, () => {
        const targetWrapper = target.element().closest<HTMLElement>("[data-sidebar-drop-preview]");
        expect(targetWrapper?.dataset.sidebarDropPreview).toBe("before");
        expect(Number.parseFloat(getComputedStyle(targetWrapper!).paddingTop)).toBeGreaterThan(0);
        expect(document.querySelector('[data-sidebar-drag-overlay="true"]')).not.toBeNull();
      });
      await target.click();

      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.pathname).toBe(`/${THREAD_ID}`);
          expect(document.querySelector('[data-sidebar-drag-overlay="true"]')).toBeNull();
          expect(document.querySelector("[data-sidebar-drop-preview]")).toBeNull();
          expect(document.body.textContent).not.toContain("Something went wrong");
          const moveCommands = wsRequests
            .map(readDispatchedCommand)
            .filter((command) => command?.type === "sidebar.item.move");
          expect(moveCommands).toHaveLength(1);
          expect(moveCommands[0]).toMatchObject({
            item: { kind: "thread", id: OTHER_THREAD_ID },
            position: { type: "before", item: { kind: "thread", id: THREAD_ID } },
            target: { kind: "folder", folderId: PROJECT_ID },
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps one React-owned row when a thread moves into another folder and back", async () => {
    const sourceThreadTitle = "Cross-folder drag source";
    const destinationFolderTitle = "Cross-folder destination";
    const destinationThreadTitle = "Existing destination thread";
    const snapshotWithThreads = addThreadToSnapshot(
      addThreadToSnapshot(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-cross-folder-drag" as MessageId,
          targetText: "cross-folder drag target",
        }),
        OTHER_THREAD_ID,
        { title: sourceThreadTitle },
      ),
      DESTINATION_THREAD_ID,
      { title: destinationThreadTitle },
    );
    const baseSnapshot = {
      ...snapshotWithThreads,
      threads: snapshotWithThreads.threads.map((thread) =>
        thread.id === DESTINATION_THREAD_ID ? { ...thread, folderId: OTHER_PROJECT_ID } : thread,
      ),
    };
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...baseSnapshot,
        folders: [
          ...baseSnapshot.folders,
          {
            ...baseSnapshot.folders[0]!,
            id: OTHER_PROJECT_ID,
            title: destinationFolderTitle,
            workspaceRoot: "/repo/other",
          },
        ],
      },
    });
    try {
      const source = page.getByRole("button", { name: sourceThreadTitle, exact: true });
      const target = page.getByRole("button", { name: destinationFolderTitle, exact: true });

      useStore.getState().setProjectExpanded(OTHER_PROJECT_ID, false);
      await vi.waitFor(() => {
        expect(target.element().getAttribute("aria-expanded")).toBe("false");
        expect(
          page.getByRole("button", { name: destinationThreadTitle, exact: true }).elements(),
        ).toHaveLength(0);
      });

      await dragWithPointerFrames(source.element(), target.element(), 0.5, () => {
        expect(
          page
            .getByRole("button", { name: destinationFolderTitle, exact: true })
            .element()
            .getAttribute("aria-expanded"),
        ).toBe("false");
        expect(
          page.getByRole("button", { name: destinationThreadTitle, exact: true }).elements(),
        ).toHaveLength(0);
        const containerPreview = document.querySelector<HTMLElement>(
          '[data-sidebar-container-drop-preview="true"]',
        );
        expect(containerPreview).not.toBeNull();
        expect(containerPreview!.getBoundingClientRect().height).toBeGreaterThan(0);
        expect(
          page.getByRole("button", { name: sourceThreadTitle, exact: true }).elements(),
        ).toHaveLength(1);
      });

      await vi.waitFor(
        () => {
          const moveCommands = wsRequests
            .map(readDispatchedCommand)
            .filter((command) => command?.type === "sidebar.item.move");
          expect(moveCommands).toHaveLength(1);
          expect(moveCommands[0]).toMatchObject({
            item: { kind: "thread", id: OTHER_THREAD_ID },
            target: { kind: "folder", folderId: OTHER_PROJECT_ID },
          });
          expect(
            page
              .getByRole("button", { name: destinationFolderTitle, exact: true })
              .element()
              .getAttribute("aria-expanded"),
          ).toBe("false");
          expect(document.querySelector("[data-sidebar-drop-preview]")).toBeNull();
          expect(document.querySelector("[data-sidebar-container-drop-preview]")).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );

      let currentSnapshot: OrchestrationReadModel = {
        ...fixture.snapshot,
        snapshotSequence: fixture.snapshot.snapshotSequence + 1,
        threads: fixture.snapshot.threads.map((thread) =>
          thread.id === OTHER_THREAD_ID ? { ...thread, folderId: OTHER_PROJECT_ID } : thread,
        ),
      };
      fixture = { ...fixture, snapshot: currentSnapshot };
      useStore.getState().syncServerReadModel(currentSnapshot);

      await page.getByRole("button", { name: destinationFolderTitle, exact: true }).click();
      await vi.waitFor(
        () => {
          expect(
            page.getByRole("button", { name: sourceThreadTitle, exact: true }).elements(),
          ).toHaveLength(1);
        },
        { timeout: 8_000, interval: 16 },
      );

      const movedSource = page.getByRole("button", { name: sourceThreadTitle, exact: true });
      const originalThread = page.getByRole("button", { name: THREAD_TITLE, exact: true });
      await dragWithPointerFrames(movedSource.element(), originalThread.element(), 0.25, () => {
        const targetWrapper = originalThread
          .element()
          .closest<HTMLElement>("[data-sidebar-drop-preview]");
        expect(targetWrapper?.dataset.sidebarDropPreview).toBe("before");
      });

      await vi.waitFor(
        () => {
          const moveCommands = wsRequests
            .map(readDispatchedCommand)
            .filter((command) => command?.type === "sidebar.item.move");
          expect(moveCommands).toHaveLength(2);
          expect(moveCommands[1]).toMatchObject({
            item: { kind: "thread", id: OTHER_THREAD_ID },
            position: { type: "before", item: { kind: "thread", id: THREAD_ID } },
            target: { kind: "folder", folderId: PROJECT_ID },
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      currentSnapshot = {
        ...currentSnapshot,
        snapshotSequence: currentSnapshot.snapshotSequence + 1,
        threads: currentSnapshot.threads.map((thread) =>
          thread.id === OTHER_THREAD_ID ? { ...thread, folderId: PROJECT_ID } : thread,
        ),
      };
      fixture = { ...fixture, snapshot: currentSnapshot };
      useStore.getState().syncServerReadModel(currentSnapshot);

      await vi.waitFor(
        () => {
          expect(
            page.getByRole("button", { name: sourceThreadTitle, exact: true }).elements(),
          ).toHaveLength(1);
          expect(document.body.textContent).not.toContain("Unable to move sidebar item");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("ends the pointer drag before sidebar persistence settles", async () => {
    const otherThreadTitle = "Delayed sidebar move target";
    const nativeApi = readNativeApi();
    if (!nativeApi) throw new Error("Expected browser native API fixture.");

    let releaseMove!: () => void;
    let overlayPresentWhenMoveDispatched: boolean | null = null;
    const moveGate = new Promise<void>((resolve) => {
      releaseMove = resolve;
    });
    const previousNativeApi = window.nativeApi;
    Object.defineProperty(window, "nativeApi", {
      configurable: true,
      value: {
        ...nativeApi,
        orchestration: {
          ...nativeApi.orchestration,
          dispatchCommand: async (
            command: Parameters<typeof nativeApi.orchestration.dispatchCommand>[0],
          ) => {
            if (command.type !== "sidebar.item.move") {
              return nativeApi.orchestration.dispatchCommand(command);
            }
            overlayPresentWhenMoveDispatched = Boolean(
              document.querySelector('[data-sidebar-drag-overlay="true"]'),
            );
            wsRequests.push({
              _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
              command,
            });
            await moveGate;
            return { sequence: fixture.snapshot.snapshotSequence + 1 };
          },
        },
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: addThreadToSnapshot(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-delayed-sidebar-move" as MessageId,
          targetText: "delayed sidebar move target",
        }),
        OTHER_THREAD_ID,
        { title: otherThreadTitle },
      ),
    });
    try {
      const source = page.getByRole("button", { name: otherThreadTitle, exact: true });
      const target = page.getByRole("button", { name: THREAD_TITLE, exact: true });

      await userEvent.dragAndDrop(source, target);

      await vi.waitFor(
        () => {
          expect(hasDispatchedCommandType("sidebar.item.move")).toBe(true);
          expect(overlayPresentWhenMoveDispatched).toBe(false);
          expect(document.querySelector('[data-sidebar-drag-overlay="true"]')).toBeNull();
          expect(document.body.textContent).not.toContain("Something went wrong");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      releaseMove();
      await mounted.cleanup();
      if (previousNativeApi) {
        Object.defineProperty(window, "nativeApi", {
          configurable: true,
          value: previousNativeApi,
        });
      } else {
        Reflect.deleteProperty(window, "nativeApi");
      }
    }
  });

  it("removes the drag preview when pointer capture ends without a pointerup", async () => {
    const otherThreadTitle = "Interrupted pointer drag target";
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: addThreadToSnapshot(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-interrupted-sidebar-drag" as MessageId,
          targetText: "interrupted sidebar drag target",
        }),
        OTHER_THREAD_ID,
        { title: otherThreadTitle },
      ),
    });
    let sawDragOverlay = false;
    let lostPointerCaptureCount = 0;
    const overlayObserver = new MutationObserver(() => {
      if (document.querySelector('[data-sidebar-drag-overlay="true"]')) sawDragOverlay = true;
    });
    const recordLostPointerCapture = () => {
      lostPointerCaptureCount += 1;
    };
    const swallowPointerUp = (event: PointerEvent) => event.stopImmediatePropagation();
    overlayObserver.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("lostpointercapture", recordLostPointerCapture, { capture: true });
    window.addEventListener("pointerup", swallowPointerUp, { capture: true });
    try {
      const source = page.getByRole("button", { name: otherThreadTitle, exact: true });
      const target = page.getByRole("button", { name: THREAD_TITLE, exact: true });

      await userEvent.dragAndDrop(source, target);

      await vi.waitFor(
        () => {
          expect(sawDragOverlay).toBe(true);
          expect(lostPointerCaptureCount).toBeGreaterThan(0);
          expect(document.querySelector('[data-sidebar-drag-overlay="true"]')).toBeNull();
          expect(document.body.textContent).not.toContain("Something went wrong");
          expect(
            wsRequests
              .map(readDispatchedCommand)
              .filter((command) => command?.type === "sidebar.item.move"),
          ).toHaveLength(1);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      overlayObserver.disconnect();
      document.removeEventListener("lostpointercapture", recordLostPointerCapture, {
        capture: true,
      });
      window.removeEventListener("pointerup", swallowPointerUp, { capture: true });
      await mounted.cleanup();
    }
  });

  it("editing a queued follow-up removes only that row and restores its images to the composer", async () => {
    const queuedImage = createComposerImage({
      id: "queued-image-1",
      previewUrl: "blob:queued-image-1",
      name: "queued-image.png",
    });
    const firstQueuedPrompt = "first queued prompt with image";
    const secondQueuedPrompt = "second queued prompt stays queued";

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-running-edit-queue" as MessageId,
        targetText: "running edit queue target",
        sessionStatus: "running",
      }),
    });

    try {
      useComposerDraftStore.getState().enqueueQueuedTurn(THREAD_ID, {
        id: "queued-turn-1",
        kind: "chat",
        createdAt: NOW_ISO,
        previewText: firstQueuedPrompt,
        prompt: firstQueuedPrompt,
        images: [queuedImage],
        files: [],
        assistantSelections: [],
        terminalContexts: [],
        fileComments: [],
        pastedTexts: [],
        skills: [],
        mentions: [],
        selectedProvider: "codex",
        selectedModel: "gpt-5",
        selectedPromptEffort: null,
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        connectionId: TEST_CONNECTION_ID,
        runtimeMode: "full-access",
      });
      useComposerDraftStore.getState().enqueueQueuedTurn(THREAD_ID, {
        id: "queued-turn-2",
        kind: "chat",
        createdAt: NOW_ISO,
        previewText: secondQueuedPrompt,
        prompt: secondQueuedPrompt,
        images: [],
        files: [],
        assistantSelections: [],
        terminalContexts: [],
        fileComments: [],
        pastedTexts: [],
        skills: [],
        mentions: [],
        selectedProvider: "codex",
        selectedModel: "gpt-5",
        selectedPromptEffort: null,
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        connectionId: TEST_CONNECTION_ID,
        runtimeMode: "full-access",
      });

      await vi.waitFor(
        () => {
          expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(2);
          expect(
            useComposerDraftStore
              .getState()
              .draftsByThreadId[THREAD_ID]?.queuedTurns.every(
                (queuedTurn) => queuedTurn.serverAcceptedAt !== undefined,
              ),
          ).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );

      const actionButtons = document.querySelectorAll<HTMLButtonElement>(
        'button[aria-label="Queued follow-up actions"]',
      );
      actionButtons[0]?.click();

      const editMenuItem = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[data-slot="menu-item"]')).find(
            (item) => item.textContent?.trim() === "Edit queued prompt",
          ) ?? null,
        "Unable to find edit queued prompt menu item.",
      );
      editMenuItem.click();

      await vi.waitFor(
        () => {
          const queuedRows = document.querySelectorAll<HTMLElement>(
            '[data-testid="queued-follow-up-row"]',
          );
          expect(queuedRows).toHaveLength(1);
          expect(queuedRows[0]?.textContent ?? "").toContain(secondQueuedPrompt);
          expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
            firstQueuedPrompt,
          );
          expect(
            useComposerDraftStore
              .getState()
              .draftsByThreadId[THREAD_ID]?.images.map((image) => image.name),
          ).toEqual(["queued-image.png"]);
          // The restored image renders as a thumbnail chip whose filename lives in
          // its accessible label/title, not in text content.
          expect(document.querySelector('[aria-label="Preview queued-image.png"]')).not.toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );

      const deleteButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>('button[aria-label="Delete queued follow-up"]'),
        "Unable to find queued Delete button.",
      );
      deleteButton.click();
      await vi.waitFor(
        () => {
          expect(
            wsRequests
              .map(readDispatchedCommand)
              .some((command) => command?.type === "thread.turn.cancel-queued"),
          ).toBe(true);
          expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(0);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("auto-dispatches a queued turn without wiping the live composer draft", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    const queuedPrompt = "queued prompt that should auto-send";
    const draftBeingTyped = "draft the user is still typing";

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-auto-dispatch-target" as MessageId,
        targetText: "auto dispatch target",
        // Idle session so the auto-dispatch effect (gated on phase !== "running")
        // drains the queue, mirroring a turn that just finished.
        sessionStatus: "ready",
      }),
    });

    try {
      // The user is mid-draft in the composer while a turn-completion drain fires.
      useComposerDraftStore.getState().setPrompt(THREAD_ID, draftBeingTyped);
      useComposerDraftStore.getState().enqueueQueuedTurn(THREAD_ID, {
        id: "queued-turn-auto",
        kind: "chat",
        createdAt: NOW_ISO,
        previewText: queuedPrompt,
        prompt: queuedPrompt,
        images: [],
        files: [],
        assistantSelections: [],
        terminalContexts: [],
        fileComments: [],
        pastedTexts: [],
        skills: [],
        mentions: [],
        selectedProvider: "codex",
        selectedModel: "gpt-5",
        selectedPromptEffort: null,
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        connectionId: TEST_CONNECTION_ID,
        runtimeMode: "full-access",
      });

      await vi.waitFor(
        () => {
          const turnStartRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              typeof request.command === "object" &&
              request.command !== null &&
              "type" in request.command &&
              request.command.type === "thread.turn.start" &&
              "threadId" in request.command &&
              request.command.threadId === THREAD_ID &&
              "message" in request.command &&
              typeof request.command.message === "object" &&
              request.command.message !== null &&
              "text" in request.command.message &&
              typeof request.command.message.text === "string" &&
              request.command.message.text.includes(queuedPrompt),
          );
          expect(turnStartRequest).toBeTruthy();
          // The durable queue remains visible until the server promotes it.
          expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(1);
          expect(
            useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.queuedTurns[0]
              ?.serverAcceptedAt,
          ).toBeTruthy();
          // The in-progress composer draft is left untouched.
          expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
            draftBeingTyped,
          );
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  it("auto-dispatches a queued chat turn with its attachments", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    const queuedPrompt = "queued chat turn that must stay a chat message";
    const queuedImage = createComposerImage({
      id: "queued-plan-image-1",
      previewUrl: "blob:queued-plan-image-1",
      name: "queued-plan-image.png",
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithSettledInlinePlan(),
    });

    try {
      await waitForComposerEditor();
      useComposerDraftStore.getState().enqueueQueuedTurn(THREAD_ID, {
        id: "queued-turn-plan-chat",
        kind: "chat",
        createdAt: NOW_ISO,
        previewText: queuedPrompt,
        prompt: queuedPrompt,
        images: [queuedImage],
        files: [],
        assistantSelections: [],
        terminalContexts: [],
        fileComments: [],
        pastedTexts: [],
        skills: [],
        mentions: [],
        selectedProvider: "codex",
        selectedModel: "gpt-5",
        selectedPromptEffort: null,
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        connectionId: TEST_CONNECTION_ID,
        runtimeMode: "full-access",
      });

      await vi.waitFor(
        () => {
          const turnStartRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              typeof request.command === "object" &&
              request.command !== null &&
              "type" in request.command &&
              request.command.type === "thread.turn.start" &&
              "threadId" in request.command &&
              request.command.threadId === THREAD_ID &&
              "message" in request.command &&
              typeof request.command.message === "object" &&
              request.command.message !== null &&
              "text" in request.command.message &&
              typeof request.command.message.text === "string" &&
              request.command.message.text.includes(queuedPrompt),
          );
          expect(turnStartRequest).toBeTruthy();
          const command = turnStartRequest!.command as {
            message?: {
              attachments?: Array<{ type?: unknown; name?: unknown }>;
            };
          };
          const attachments = command.message?.attachments ?? [];
          expect(attachments).toHaveLength(1);
          expect(attachments[0]?.type).toBe("image");
          expect(attachments[0]?.name).toBe("queued-plan-image.png");
          expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(1);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  it("keeps the new thread selected after creating it from the global shortcut", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-new-thread-test" as MessageId,
        targetText: "new thread selection test",
      }),
    });

    try {
      const { path: newThreadPath, threadId: newThreadId } =
        await createProjectThreadWithShortcut(mounted);

      // The composer editor should be present for the new draft thread.
      await waitForComposerEditor();

      // Simulate the snapshot sync arriving from the server after the draft
      // thread has been promoted to a server thread (thread.create + turn.start
      // succeeded). The snapshot now includes the new thread, and the sync
      // should clear the draft without disrupting the route.
      const { syncServerReadModel } = useStore.getState();
      syncServerReadModel(addThreadToSnapshot(fixture.snapshot, newThreadId));

      // Clear the draft now that the server thread exists (mirrors EventRouter behavior).
      useComposerDraftStore.getState().clearDraftThread(newThreadId);

      // The route should still be on the new thread — not redirected away.
      await waitForURL(
        mounted.router,
        (path) => path === newThreadPath,
        "New thread should remain selected after snapshot sync clears the draft.",
      );

      // The empty thread view and composer should still be visible.
      await expect.element(page.getByTestId("composer-editor")).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the optimistic first message visible while a new thread detail page reconciles", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-new-thread-hydration-baseline" as MessageId,
        targetText: "new thread hydration baseline",
      }),
    });
    const previousNativeApi = window.nativeApi;
    const nativeApi = readNativeApi();
    expect(nativeApi).toBeDefined();
    let releaseDetailPage!: () => void;
    const detailPageGate = new Promise<void>((resolve) => {
      releaseDetailPage = resolve;
    });
    let releaseTurnStart!: () => void;
    const turnStartGate = new Promise<void>((resolve) => {
      releaseTurnStart = resolve;
    });

    try {
      const { threadId: newThreadId } = await createProjectThreadWithShortcut(mounted);
      Object.defineProperty(window, "nativeApi", {
        configurable: true,
        value: {
          ...nativeApi,
          orchestration: {
            ...nativeApi?.orchestration,
            dispatchCommand: vi.fn(async (command: unknown) => {
              wsRequests.push({
                _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
                command,
              });
              if (
                command !== null &&
                typeof command === "object" &&
                "type" in command &&
                command.type === "thread.create"
              ) {
                fixture = {
                  ...fixture,
                  snapshot: addThreadToSnapshot(fixture.snapshot, newThreadId),
                };
              }
              if (
                command !== null &&
                typeof command === "object" &&
                "type" in command &&
                command.type === "thread.turn.start"
              ) {
                await turnStartGate;
              }
              return { sequence: fixture.snapshot.snapshotSequence };
            }),
            getShellSnapshot: vi.fn(async () => createShellSnapshotFromReadModel(fixture.snapshot)),
            getThreadTurnsPage: vi.fn(async ({ threadId }: { threadId: ThreadId }) => {
              if (threadId === newThreadId) {
                await detailPageGate;
              }
              return createThreadTurnsPageFromFixtureSnapshot(threadId);
            }),
          },
        },
      });

      const prompt = "first message must not become a loading placeholder";
      await page.getByTestId("composer-editor").fill(prompt);
      await expect.element(page.getByTestId("composer-editor")).toHaveTextContent(prompt);
      await vi.waitFor(() => {
        expect(useComposerDraftStore.getState().draftsByThreadId[newThreadId]?.prompt).toBe(prompt);
      });
      const sendButton = await waitForSendButton();
      await vi.waitFor(() => expect(sendButton.disabled).toBe(false));
      sendButton.click();

      await vi.waitFor(
        () => {
          expect(hasDispatchedCommandType("thread.create")).toBe(true);
          expect(hasDispatchedCommandType("thread.turn.start")).toBe(true);
          expect(useStore.getState().threadDetailSyncById?.[newThreadId]).toBe("known-empty");
          expect(document.body.textContent).toContain(prompt);
          expect(document.body.textContent).not.toContain("Loading conversation");
        },
        { timeout: 8_000, interval: 16 },
      );

      releaseTurnStart();
      releaseDetailPage();
      await vi.waitFor(() => {
        expect(useStore.getState().threadDetailSyncById?.[newThreadId]).toBe("synced");
      });
    } finally {
      releaseTurnStart();
      releaseDetailPage();
      if (previousNativeApi) {
        Object.defineProperty(window, "nativeApi", {
          configurable: true,
          value: previousNativeApi,
        });
      } else {
        Reflect.deleteProperty(window, "nativeApi");
      }
      await mounted.cleanup();
    }
  });

  it("uses the active folder before the stored latest folder for the global new-thread shortcut", async () => {
    useLatestProjectStore.setState({ latestFolderId: PROJECT_ID });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withActiveInboxThread(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-global-new-thread-latest-project" as MessageId,
          targetText: "global new thread latest project",
        }),
      ),
    });

    try {
      const { path: newThreadPath, threadId: newThreadId } = await createProjectThreadWithShortcut(
        mounted,
        "Global New thread should create a draft in the active folder.",
      );
      expect(useComposerDraftStore.getState().getDraftThread(newThreadId)?.folderId).toBe(
        INBOX_FOLDER_ID,
      );
      await expect.element(page.getByText("Type path", { exact: true })).not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not expose the removed global New thread action in the command palette", async () => {
    useLatestProjectStore.setState({ latestFolderId: PROJECT_ID });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withActiveInboxThread(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-palette-new-thread-latest-project" as MessageId,
          targetText: "palette new thread latest project",
        }),
      ),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "sidebar.search",
              shortcut: {
                key: "k",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
            },
          ],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      dispatchConfiguredShortcut(window, { key: "k" });
      expect(
        Array.from(document.querySelectorAll<HTMLElement>('[data-slot="command-item"]')).some(
          (item) => item.textContent?.trim().startsWith("New thread"),
        ),
      ).toBe(false);
    } finally {
      await mounted.cleanup();
    }
  });

  it("starts an inline folder when the global New thread action has no usable folder target", async () => {
    useLatestProjectStore.setState({ latestFolderId: PROJECT_ID });
    const snapshot = withActiveInboxThread(
      createSnapshotForTargetUser({
        targetMessageId: "msg-user-global-new-thread-no-project" as MessageId,
        targetText: "global new thread no project",
      }),
    );
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        folders: [],
      },
    });

    try {
      const initialPath = mounted.router.state.location.pathname;
      await waitForNewThreadShortcutLabel();
      dispatchChatNewShortcut();

      await expect
        .element(page.getByRole("textbox", { name: "New folder name" }))
        .toBeInTheDocument();
      expect(mounted.router.state.location.pathname).toBe(initialPath);
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not start an inline folder before project hydration completes", async () => {
    useLatestProjectStore.setState({ latestFolderId: PROJECT_ID });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withActiveInboxThread(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-global-new-thread-before-hydration" as MessageId,
          targetText: "global new thread before hydration",
        }),
      ),
    });

    try {
      useStore.setState({ folders: [], threadsHydrated: false });
      await waitForLayout();
      const initialPath = mounted.router.state.location.pathname;
      await waitForServerConfigToApply();
      dispatchChatNewShortcut();
      await waitForLayout();

      await expect
        .element(page.getByRole("textbox", { name: "New folder name" }))
        .not.toBeInTheDocument();
      expect(mounted.router.state.location.pathname).toBe(initialPath);
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders the selected working directory and folder picker actions", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withOpenProjectPickerFixtures(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-project-picker-switch-test" as MessageId,
          targetText: "project picker switch test",
        }),
      ),
    });

    try {
      const { path: newThreadPath, threadId: newThreadId } =
        await createProjectThreadWithShortcut(mounted);

      useComposerDraftStore.getState().setDraftThreadContext(newThreadId, {});
      useComposerDraftStore.getState().setProjectDraftThreadId(OTHER_PROJECT_ID, OTHER_THREAD_ID);
      useComposerDraftStore.getState().setPrompt(OTHER_THREAD_ID, "replace this other draft");

      const projectPickerTrigger = page.getByTestId("workspace-picker-trigger");
      await expect.element(projectPickerTrigger).toHaveTextContent("project");
      await projectPickerTrigger.click();

      await expect.element(page.getByText("Choose from computer…")).toBeInTheDocument();
      await expect.element(page.getByText("Don't work in a folder")).toBeInTheDocument();
      await expect.element(page.getByText(/Folders on this/)).not.toBeInTheDocument();

      expect(mounted.router.state.location.pathname).toBe(newThreadPath);
    } finally {
      await mounted.cleanup();
    }
  });

  it("can clear an empty draft's working directory before first send", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withInboxFolder(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-project-picker-home-test" as MessageId,
          targetText: "project picker home test",
        }),
      ),
      configureFixture: (nextFixture) => {
        nextFixture.welcome = {
          ...nextFixture.welcome,
          homeDir: "/Users/tester",
          chatWorkspaceRoot: "/Users/tester/Documents/Penkra",
        };
      },
    });

    try {
      const { threadId: newThreadId } = await createProjectThreadWithShortcut(mounted);

      useComposerDraftStore.getState().setDraftThreadContext(newThreadId, {
        workingDirectory: "/repo/project",
      });

      const projectPickerTrigger = page.getByTestId("workspace-picker-trigger");
      await expect.element(projectPickerTrigger).toBeInTheDocument();
      await projectPickerTrigger.click();
      await page.getByText("Don't work in a folder").click();

      await vi.waitFor(
        () => {
          const pickerText =
            document.querySelector<HTMLElement>('[data-slot="combobox-popup"]')?.textContent ?? "";
          expect(
            useComposerDraftStore.getState().getDraftThread(newThreadId),
            `Project reset did not complete. Picker content: ${pickerText}`,
          ).toMatchObject({
            folderId: PROJECT_ID,
            workingDirectory: null,
          });
        },
        { timeout: 8_000, interval: 16 },
      );
      await expect.element(page.getByTestId("workspace-picker-trigger")).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("moves an Inbox draft into a recent working folder without carrying branch", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          folderId: INBOX_FOLDER_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          entryPoint: "chat",
        },
      },
      projectDraftThreadIdByFolderId: {
        [INBOX_FOLDER_ID]: THREAD_ID,
      },
    });

    const recentInboxSnapshot = withInboxFolder(
      createSnapshotForTargetUser({
        targetMessageId: "msg-user-home-recent-folder" as MessageId,
        targetText: "recent home folder",
      }),
    );
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...recentInboxSnapshot,
        threads: recentInboxSnapshot.threads.map((thread) => ({
          ...thread,
          id: OTHER_THREAD_ID,
          folderId: INBOX_FOLDER_ID,
          spaceId: TEST_SPACE_ID,
          workingDirectory: "/repo/project",
          session: thread.session ? { ...thread.session, threadId: OTHER_THREAD_ID } : null,
        })),
      },
      configureFixture: (nextFixture) => {
        nextFixture.welcome = {
          ...nextFixture.welcome,
          homeDir: "/Users/tester",
          chatWorkspaceRoot: "/Users/tester/Documents/Penkra",
        };
        nextFixture.gitBranchByCwd = {
          "/Users/tester": "home-main",
          "/repo/project": "main",
        };
      },
    });

    try {
      const workspacePickerTrigger = page.getByTestId("workspace-picker-trigger");
      await expect.element(workspacePickerTrigger).toBeInTheDocument();
      const composerBlockBefore = document.querySelector<HTMLElement>(
        '[data-empty-landing-composer-block="true"]',
      );
      const controlsBefore =
        composerBlockBefore?.querySelector<HTMLElement>(".chat-composer-shell") ?? null;
      expect(controlsBefore).not.toBeNull();
      expect(composerBlockBefore).not.toBeNull();
      const beforeRect = controlsBefore!.getBoundingClientRect();
      const composerBlockBeforeRect = composerBlockBefore!.getBoundingClientRect();
      await workspacePickerTrigger.click();

      const projectOption = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[data-slot="combobox-item"]')).find(
            (item) => item.textContent?.trim() === "project",
          ) ?? null,
        "Unable to find the recent working folder option.",
      );
      projectOption.click();

      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().getDraftThread(THREAD_ID)).toMatchObject({
            folderId: INBOX_FOLDER_ID,
            workingDirectory: "/repo/project",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
      await expect.element(page.getByTestId("workspace-picker-trigger")).toBeInTheDocument();
      await expect.element(page.getByRole("button", { name: "This Mac" })).toBeInTheDocument();
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      const composerBlockAfter = document.querySelector<HTMLElement>(
        '[data-empty-landing-composer-block="true"]',
      );
      const controlsAfter =
        composerBlockAfter?.querySelector<HTMLElement>(".chat-composer-shell") ?? null;
      expect(controlsAfter).not.toBeNull();
      expect(composerBlockAfter).not.toBeNull();
      const afterRect = controlsAfter!.getBoundingClientRect();
      const composerBlockAfterRect = composerBlockAfter!.getBoundingClientRect();
      // Guard against the empty-pane entry animation restarting with a vertical translate
      // when the recent working-folder selection updates the draft.
      expect(
        Math.round(Math.abs(afterRect.height - beforeRect.height)),
        `Composer controls changed height ${beforeRect.height}px -> ${afterRect.height}px`,
      ).toBeLessThanOrEqual(1);
      expect(Math.round(Math.abs(afterRect.top - beforeRect.top))).toBeLessThanOrEqual(1);
      expect(
        Math.round(Math.abs(composerBlockAfterRect.top - composerBlockBeforeRect.top)),
      ).toBeLessThanOrEqual(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("selects a folder from the system picker without creating another folder", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-project-picker-new-test" as MessageId,
        targetText: "project picker new test",
      }),
    });
    const previousNativeApi = window.nativeApi;
    const wsNativeApi = readNativeApi();
    expect(wsNativeApi).toBeDefined();
    const pickFolder = vi.fn(async () => "/repo/new-project");
    const dispatchCommand = vi.fn(async (command: unknown) => {
      wsRequests.push({
        _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
        command,
      });
      if (recordFolderCreateCommand(command)) {
        return { sequence: fixture.snapshot.snapshotSequence };
      }
      return { sequence: fixture.snapshot.snapshotSequence + 1 };
    });
    Object.defineProperty(window, "nativeApi", {
      configurable: true,
      value: {
        ...wsNativeApi,
        dialogs: {
          ...wsNativeApi?.dialogs,
          pickFolder,
        },
        orchestration: {
          ...wsNativeApi?.orchestration,
          dispatchCommand,
          getShellSnapshot: vi.fn(async () => createShellSnapshotFromReadModel(fixture.snapshot)),
        },
      },
    });

    try {
      const { threadId: newThreadId } = await createProjectThreadWithShortcut(mounted);

      const projectPickerTrigger = page.getByTestId("workspace-picker-trigger");
      await expect.element(projectPickerTrigger).toBeInTheDocument();
      await projectPickerTrigger.click();
      await page.getByText("Choose from computer…").click();
      await vi.waitFor(() => {
        expect(pickFolder).toHaveBeenCalledTimes(1);
      });

      await vi.waitFor(
        () => {
          const projectCreateRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              "command" in request &&
              request.command &&
              typeof request.command === "object" &&
              "type" in request.command &&
              request.command.type === "folder.create",
          );
          expect(projectCreateRequest).toBeUndefined();
        },
        { timeout: 8_000, interval: 16 },
      );

      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().getDraftThread(newThreadId)).toMatchObject({
            folderId: PROJECT_ID,
            workingDirectory: "/repo/new-project",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(mounted.router.state.location.pathname).toBe(`/${newThreadId}`);
    } finally {
      if (previousNativeApi) {
        Object.defineProperty(window, "nativeApi", {
          configurable: true,
          value: previousNativeApi,
        });
      } else {
        Reflect.deleteProperty(window, "nativeApi");
      }
      await mounted.cleanup();
    }
  });

  it("creates a folder inline from the sidebar and shows it in the sidebar", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-create-project-dialog-test" as MessageId,
        targetText: "create project dialog test",
      }),
    });
    // This test owns the sidebar create/sync contract. Keep its command boundary
    // deterministic; WebSocket request and synchronous stream-exit behavior are
    // exercised independently by wsTransport.test.ts.
    const previousNativeApi = window.nativeApi;
    const wsNativeApi = readNativeApi();
    expect(wsNativeApi).toBeDefined();
    const getShellSnapshot = vi.fn(async () => createShellSnapshotFromReadModel(fixture.snapshot));
    Object.defineProperty(window, "nativeApi", {
      configurable: true,
      value: {
        ...wsNativeApi,
        orchestration: {
          ...wsNativeApi?.orchestration,
          dispatchCommand: vi.fn(async (command: unknown) => {
            wsRequests.push({
              _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
              command,
            });
            recordFolderCreateCommand(command);
            const createdFolder = fixture.snapshot.folders.at(-1);
            if (createdFolder) {
              queueMicrotask(() => {
                emitSyncDomainEvent?.(
                  makeDomainEvent(
                    "folder.created",
                    {
                      folderId: createdFolder.id,
                      title: createdFolder.title,
                      workspaceRoot: createdFolder.workspaceRoot,
                      defaultModelSelection: createdFolder.defaultModelSelection,
                      scripts: createdFolder.scripts,
                      iconDataUrl: createdFolder.iconDataUrl ?? null,
                      isPinned: createdFolder.isPinned ?? false,
                      spaceId: createdFolder.spaceId,
                      sidebarSortOrder: createdFolder.sidebarSortOrder ?? 0,
                      createdAt: createdFolder.createdAt,
                      updatedAt: createdFolder.updatedAt,
                    },
                    { sequence: fixture.snapshot.snapshotSequence },
                  ),
                );
              });
            }
            return { sequence: fixture.snapshot.snapshotSequence };
          }),
          getShellSnapshot,
        },
      },
    });

    try {
      await waitForServerConfigToApply();
      dispatchAddProjectShortcut();
      const folderInput = page.getByRole("textbox", { name: "New folder name" });
      await expect.element(folderInput).toBeInTheDocument();
      await folderInput.fill("New Project");
      await userEvent.keyboard("{Enter}");

      await vi.waitFor(
        () => {
          const projectCreateRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              "command" in request &&
              request.command &&
              typeof request.command === "object" &&
              "type" in request.command &&
              request.command.type === "folder.create" &&
              "workspaceRoot" in request.command &&
              request.command.workspaceRoot === null &&
              "title" in request.command &&
              request.command.title === "New Project",
          );
          expect(projectCreateRequest).toBeDefined();
        },
        { timeout: 8_000, interval: 16 },
      );

      // The command opens its draft immediately. The canonical sync event—not
      // a command-local polling lifecycle—installs the new Folder.
      await expect
        .element(page.getByRole("textbox", { name: "New folder name" }))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByText("New Project", { exact: true }).first())
        .toBeInTheDocument();
      expect(getShellSnapshot).not.toHaveBeenCalled();
    } finally {
      if (previousNativeApi) {
        Object.defineProperty(window, "nativeApi", {
          configurable: true,
          value: previousNativeApi,
        });
      } else {
        Reflect.deleteProperty(window, "nativeApi");
      }
      await mounted.cleanup();
    }
  });

  it("keeps the inline folder draft open when folder creation fails", async () => {
    const currentSpaceId = SpaceId.makeUnsafe("space-current");
    const baseSnapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-create-folder-failure" as MessageId,
      targetText: "create folder failure",
    });
    useSpacesUiStore.getState().setActiveSpaceId(currentSpaceId);
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...baseSnapshot,
        spaces: [
          {
            id: currentSpaceId,
            name: "Current",
            icon: "bag",
            sortOrder: 0,
            createdAt: NOW_ISO,
            updatedAt: NOW_ISO,
            archivedAt: null,
            deletedAt: null,
          },
        ],
        folders: baseSnapshot.folders.map((project) => ({
          ...project,
          spaceId: currentSpaceId,
        })),
      },
    });
    const previousNativeApi = window.nativeApi;
    const wsNativeApi = readNativeApi();
    expect(wsNativeApi).toBeDefined();
    Object.defineProperty(window, "nativeApi", {
      configurable: true,
      value: {
        ...wsNativeApi,
        orchestration: {
          ...wsNativeApi?.orchestration,
          dispatchCommand: vi.fn(async () => {
            throw new Error("Project creation failed for test.");
          }),
        },
      },
    });

    try {
      await waitForServerConfigToApply();
      dispatchAddProjectShortcut();
      const folderInput = page.getByRole("textbox", { name: "New folder name" });
      await folderInput.fill("Failing Project");
      await userEvent.keyboard("{Enter}");

      await expect
        .element(page.getByRole("alert"))
        .toHaveTextContent("Project creation failed for test.");
      expect(useSpacesUiStore.getState().activeSpaceId).toBe(currentSpaceId);
      await expect.element(folderInput).toBeInTheDocument();
      await expect.element(folderInput).toHaveValue("Failing Project");
    } finally {
      useSpacesUiStore.getState().setActiveSpaceId(currentSpaceId);
      if (previousNativeApi) {
        Object.defineProperty(window, "nativeApi", {
          configurable: true,
          value: previousNativeApi,
        });
      } else {
        Reflect.deleteProperty(window, "nativeApi");
      }
      await mounted.cleanup();
    }
  });

  it("snapshots sticky codex settings into a new draft thread", async () => {
    useComposerDraftStore.setState({
      stickyModelSelectionByProvider: {
        codex: {
          provider: "codex",
          model: "gpt-5.3-codex",
          options: {
            reasoningEffort: "medium",
            fastMode: true,
          },
        },
      },
      stickyActiveProvider: "codex",
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-sticky-codex-traits-test" as MessageId,
        targetText: "sticky codex traits test",
      }),
    });

    try {
      const { threadId: newThreadId } = await createProjectThreadWithShortcut(mounted);

      expect(useComposerDraftStore.getState().draftsByThreadId[newThreadId]).toMatchObject({
        modelSelectionByProvider: {
          codex: {
            provider: "codex",
            model: "gpt-5.3-codex",
            options: {
              fastMode: true,
            },
          },
        },
        activeProvider: "codex",
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("hydrates the provider alongside a sticky claude model", async () => {
    useComposerDraftStore.setState({
      stickyModelSelectionByProvider: {
        claudeAgent: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          options: {
            effort: "max",
            fastMode: true,
          },
        },
      },
      stickyActiveProvider: "claudeAgent",
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-sticky-claude-model-test" as MessageId,
        targetText: "sticky claude model test",
      }),
    });

    try {
      const { threadId: newThreadId } = await createProjectThreadWithShortcut(
        mounted,
        "Route should have changed to a new sticky claude draft thread UUID.",
      );

      expect(useComposerDraftStore.getState().draftsByThreadId[newThreadId]).toMatchObject({
        modelSelectionByProvider: {
          claudeAgent: {
            provider: "claudeAgent",
            model: "claude-opus-4-6",
            options: {
              effort: "max",
              fastMode: true,
            },
          },
        },
        activeProvider: "claudeAgent",
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("falls back to defaults when no sticky composer settings exist", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-default-codex-traits-test" as MessageId,
        targetText: "default codex traits test",
      }),
    });

    try {
      const { threadId: newThreadId } = await createProjectThreadWithShortcut(mounted);

      expect(useComposerDraftStore.getState().draftsByThreadId[newThreadId]).toBeUndefined();
    } finally {
      await mounted.cleanup();
    }
  });

  it("reuses the existing draft thread when the user clicks new thread again", async () => {
    useComposerDraftStore.setState({
      stickyModelSelectionByProvider: {
        codex: {
          provider: "codex",
          model: "gpt-5.3-codex",
          options: {
            reasoningEffort: "medium",
            fastMode: true,
          },
        },
      },
      stickyActiveProvider: "codex",
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-draft-codex-traits-precedence-test" as MessageId,
        targetText: "draft codex traits precedence test",
      }),
    });

    try {
      const { path: threadPath, threadId } = await createProjectThreadWithShortcut(
        mounted,
        "Route should have changed to a sticky draft thread UUID.",
      );

      expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toMatchObject({
        modelSelectionByProvider: {
          codex: {
            provider: "codex",
            model: "gpt-5.3-codex",
            options: {
              fastMode: true,
            },
          },
        },
        activeProvider: "codex",
      });

      useComposerDraftStore.getState().setModelSelection(threadId, {
        provider: "codex",
        model: "gpt-5.4",
        options: {
          reasoningEffort: "low",
          fastMode: true,
        },
      });
      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toMatchObject({
            modelSelectionByProvider: {
              codex: {
                provider: "codex",
                model: "gpt-5.4",
                options: {
                  reasoningEffort: "low",
                  fastMode: true,
                },
              },
            },
            activeProvider: "codex",
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      dispatchChatNewShortcut();
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 64);
      });

      expect(mounted.router.state.location.pathname).toBe(threadPath);
      expect(useComposerDraftStore.getState().projectDraftThreadIdByFolderId[PROJECT_ID]).toBe(
        threadId,
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates a new thread from the global chat.new shortcut", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-chat-shortcut-test" as MessageId,
        targetText: "chat shortcut test",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "chat.new",
              shortcut: {
                key: "n",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      await waitForNewThreadShortcutLabel();
      await waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      await waitForLayout();
      await triggerChatNewShortcutUntilPath(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID from the shortcut.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("promotes terminal-first shortcut threads so they render as terminal rows", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-terminal-shortcut-test" as MessageId,
        targetText: "terminal shortcut test",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "chat.newTerminal",
              shortcut: {
                key: "t",
                metaKey: false,
                ctrlKey: false,
                shiftKey: true,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      await waitForLayout();
      const newThreadPath = await triggerTerminalThreadShortcutUntilPath(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new terminal-first draft thread UUID from the shortcut.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      await vi.waitFor(
        () => {
          expect(
            wsRequests.some(
              (request) =>
                request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
                typeof request.command === "object" &&
                request.command !== null &&
                "type" in request.command &&
                "threadId" in request.command &&
                request.command.type === "thread.create" &&
                request.command.threadId === newThreadId,
            ),
          ).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );

      useStore.getState().syncServerReadModel(
        addThreadToSnapshot(fixture.snapshot, newThreadId, {
          title: "New terminal",
        }),
      );
      useComposerDraftStore.getState().clearDraftThread(newThreadId);

      await vi.waitFor(
        () => {
          const terminalThreadRow = Array.from(
            document.querySelectorAll<HTMLElement>("[data-thread-level]"),
          ).find((row) => row.textContent?.includes("New terminal"));
          expect(terminalThreadRow).not.toBeNull();
          expect(terminalThreadRow?.textContent).toContain("New terminal");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  it("does not expose plan mode or plan details in the composer", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-plan-mode-toggle-test" as MessageId,
        targetText: "plan mode toggle test",
      }),
    });

    try {
      await page.getByLabelText("Attach files").click();
      expect(document.body.textContent).not.toContain("Plan mode");
      expect(document.body.textContent).not.toContain("Plan details");
      expect(document.querySelector('[aria-label="Show plan details sidebar"]')).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates a fresh draft after the previous draft thread is promoted", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-promoted-draft-shortcut-test" as MessageId,
        targetText: "promoted draft shortcut test",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "chat.new",
              shortcut: {
                key: "n",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      await waitForNewThreadShortcutLabel();
      await waitForServerConfigToApply();
      const { path: promotedThreadPath, threadId: promotedThreadId } =
        await createProjectThreadWithShortcut(
          mounted,
          "Route should have changed to a promoted draft thread UUID.",
        );

      const { syncServerReadModel } = useStore.getState();
      syncServerReadModel(addThreadToSnapshot(fixture.snapshot, promotedThreadId));
      useComposerDraftStore.getState().clearDraftThread(promotedThreadId);

      const freshThreadPath = await triggerChatNewShortcutUntilPath(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path) && path !== promotedThreadPath,
        "Shortcut should create a fresh draft instead of reusing the promoted thread.",
      );
      expect(freshThreadPath).not.toBe(promotedThreadPath);
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders historical proposed plans as ordinary transcript content", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithHistoricalPlanMessage(),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("deep hidden detail only after expand");
          expect(document.body.textContent).not.toContain("Expand plan");
          expect(document.querySelector('[aria-label="Close plan sidebar"]')).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not mount a task-progress panel above the composer", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithActiveInlinePlan(),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).not.toContain("1 out of 3 tasks completed");
          expect(document.querySelector('[data-testid="active-task-list-card"]')).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not expose provider task progress for active turns", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithActiveInlinePlan(),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).not.toContain("1 out of 3 tasks completed");
          expect(document.querySelector('[data-testid="active-task-list-card"]')).toBeNull();
          expect(document.querySelector('button[title="Open tasks sidebar"]')).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("hides an unfinished task list once the latest turn is settled", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithSettledInlinePlan(),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("Finished the investigation.");
          expect(document.body.textContent).not.toContain("1 out of 3 tasks completed");
          expect(document.querySelector('[data-testid="active-task-list-card"]')).toBeNull();
          expect(document.body.textContent).not.toContain("1 background agent");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("hides a completed task list once the latest turn is settled", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithSettledCompletedInlinePlan(),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("Finished the investigation.");
          expect(document.body.textContent).not.toContain("3 out of 3 tasks completed");
          expect(document.querySelector('[data-testid="active-task-list-card"]')).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("acknowledges the same unseen completion identity used by the sidebar", async () => {
    const settledSnapshot = createSnapshotWithSettledInlinePlan();
    const completionAt = isoAt(1_004);
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...settledSnapshot,
        threads: settledSnapshot.threads.map((thread) =>
          thread.id === THREAD_ID
            ? {
                ...thread,
                lastVisitedAt: isoAt(1_003),
                latestTurn: thread.latestTurn
                  ? {
                      ...thread.latestTurn,
                      // Completion notification acknowledgement must not depend
                      // on optional provider timing metadata.
                      startedAt: null,
                    }
                  : null,
              }
            : thread,
        ),
      },
    });

    try {
      await vi.waitFor(
        () => {
          const visitCommands = wsRequests
            .map(readDispatchedCommand)
            .filter((command) => command?.type === "thread.update" && "lastVisitedAt" in command);
          expect(visitCommands).toHaveLength(1);
          expect(visitCommands[0]).toMatchObject({
            type: "thread.update",
            threadId: THREAD_ID,
          });
          if (visitCommands[0]?.type !== "thread.update") return;
          const lastVisitedAt = visitCommands[0].lastVisitedAt;
          expect(
            Date.parse(typeof lastVisitedAt === "string" ? lastVisitedAt : ""),
          ).toBeGreaterThanOrEqual(Date.parse(completionAt));
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("hides the stop button once a completed turn is no longer live", async () => {
    const settledSnapshot = createSnapshotWithSettledInlinePlan();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...settledSnapshot,
        threads: settledSnapshot.threads.map((thread) =>
          thread.id === THREAD_ID
            ? {
                ...thread,
                messages: thread.messages.map((message) =>
                  message.role === "assistant"
                    ? {
                        ...message,
                        streaming: true,
                      }
                    : message,
                ),
              }
            : thread,
        ),
      },
    });

    try {
      await vi.waitFor(
        () => {
          expect(
            document.querySelector<HTMLButtonElement>('button[aria-label="Stop generation"]'),
          ).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("settles an orphaned running command when its turn was interrupted", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithInterruptedCommand(),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).not.toContain("Running sleep 45");
          expect(
            document.querySelector<HTMLButtonElement>('button[aria-label="Stop generation"]'),
          ).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );

      const settledTrigger = Array.from(
        document.querySelectorAll<HTMLButtonElement>("button"),
      ).find((element) => element.textContent?.includes("Worked for"));
      expect(settledTrigger).not.toBeUndefined();
      settledTrigger!.click();
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("Cancelled sleep 45");
          expect(document.body.textContent).not.toContain("Running sleep 45");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("collapses a settled leading tool run mid-turn, then folds into Worked for after the grace delay", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithInlineToolOverflow({ active: true }),
    });

    try {
      // The tools already gave way to the assistant's narration block, so even
      // while the turn is live the run compacts behind its summary row.
      await vi.waitFor(
        () => {
          const summaryTrigger = Array.from(
            document.querySelectorAll<HTMLButtonElement>("button[aria-expanded]"),
          ).find((element) => element.textContent?.includes("Used 6 tools"));
          expect(summaryTrigger).not.toBeUndefined();
          expect(summaryTrigger!.getAttribute("aria-expanded")).toBe("false");
          expect(document.body.textContent).not.toContain("Tool 1");
        },
        { timeout: 8_000, interval: 16 },
      );

      useStore
        .getState()
        .syncServerReadModel(createSnapshotWithInlineToolOverflow({ active: false }));

      // The first settled paint keeps the live layout: no "Worked for" fold yet.
      expect(document.querySelector("[data-settled-turn-collapse-transition='true']")).toBeNull();
      expect(document.body.textContent).toContain("Used 6 tools");

      await new Promise<void>((resolve) => {
        window.setTimeout(() => resolve(), 260);
      });

      // Once the grace delay lapses the settled turn folds into "Worked for…",
      // but the old details stay mounted briefly inside the shared disclosure
      // close transition so the transcript height eases down instead of snapping.
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("Worked for");
          const transitionClone = document.querySelector(
            "[data-settled-turn-collapse-transition='true']",
          );
          expect(transitionClone).not.toBeNull();
          expect(transitionClone?.hasAttribute("inert")).toBe(true);
          expect(transitionClone?.querySelector("[aria-hidden='true'][inert]")).not.toBeNull();
          expect(transitionClone?.textContent).toContain("Used 6 tools");
        },
        { timeout: 8_000, interval: 16 },
      );

      await new Promise<void>((resolve) => {
        window.setTimeout(() => resolve(), 320);
      });

      // After the close motion finishes, details are only available by opening
      // the "Worked for…" disclosure.
      await vi.waitFor(
        () => {
          expect(
            document.querySelector("[data-settled-turn-collapse-transition='true']"),
          ).toBeNull();
          expect(document.body.textContent).not.toContain("Tool 1");
          const settledTrigger = Array.from(
            document.querySelectorAll<HTMLButtonElement>("button"),
          ).find((element) => element.textContent?.includes("Worked for"));
          if (settledTrigger) {
            expect(settledTrigger.getAttribute("aria-expanded")).toBe("false");
          }
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });
});
