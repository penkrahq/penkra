// FILE: storeTestFixtures.ts
// Purpose: Shared builders for store facade, projection, and event reducer tests.
// Exports: Minimal normalized-state and orchestration payload fixtures.

import {
  EventId,
  FolderId,
  SpaceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationStartupSnapshot,
  type OrchestrationThreadActivity,
} from "@penkra/contracts";

import { getThreadsFromState } from "./threadDerivation";
import type { AppState } from "./storeState";
import type { Thread } from "./types";

const TEST_SPACE_ID = SpaceId.makeUnsafe("space-test");

export function makeThread(overrides: Partial<Thread> = {}): Thread {
  const id = overrides.id ?? ThreadId.makeUnsafe("thread-1");
  const thread = {
    id,
    codexThreadId: null,
    folderId: FolderId.makeUnsafe("project-1"),
    title: "Thread",
    modelSelection: {
      provider: "codex",
      model: "gpt-5-codex",
    },
    session: null,
    messages: [],
    activities: [],
    error: null,
    createdAt: "2026-02-13T00:00:00.000Z",
    latestTurn: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  };
  return Object.assign({}, thread, {
    id,
  }) as Thread;
}

export function makeDomainEvent<TType extends OrchestrationEvent["type"]>(
  type: TType,
  payload: Extract<OrchestrationEvent, { type: TType }>["payload"],
  overrides: Partial<Omit<Extract<OrchestrationEvent, { type: TType }>, "type" | "payload">> = {},
): Extract<OrchestrationEvent, { type: TType }> {
  const aggregateId =
    "threadId" in payload
      ? payload.threadId
      : "spaceId" in payload
        ? payload.spaceId
        : "folderId" in payload
          ? payload.folderId
          : FolderId.makeUnsafe("project-1");
  const aggregateKind =
    "threadId" in payload ? "thread" : "spaceId" in payload ? "space" : "folder";
  return {
    type,
    payload,
    sequence: overrides.sequence ?? 1,
    eventId: overrides.eventId ?? EventId.makeUnsafe(`event-${crypto.randomUUID()}`),
    aggregateKind: overrides.aggregateKind ?? aggregateKind,
    aggregateId,
    occurredAt: overrides.occurredAt ?? "2026-02-27T00:00:00.000Z",
    commandId: overrides.commandId ?? null,
    causationEventId: overrides.causationEventId ?? null,
    correlationId: overrides.correlationId ?? null,
    metadata: overrides.metadata ?? {},
    ...overrides,
  } as Extract<OrchestrationEvent, { type: TType }>;
}

export function makeActivity(overrides: {
  id?: string;
  createdAt?: string;
  kind?: string;
  summary?: string;
  tone?: OrchestrationThreadActivity["tone"];
  payload?: OrchestrationThreadActivity["payload"];
  turnId?: string | null;
  sequence?: number;
}): OrchestrationThreadActivity {
  return {
    id: EventId.makeUnsafe(overrides.id ?? crypto.randomUUID()),
    createdAt: overrides.createdAt ?? "2026-02-23T00:00:00.000Z",
    kind: overrides.kind ?? "tool.started",
    summary: overrides.summary ?? "Tool call",
    tone: overrides.tone ?? "tool",
    payload: overrides.payload ?? {},
    turnId: overrides.turnId ? TurnId.makeUnsafe(overrides.turnId) : null,
    ...(overrides.sequence !== undefined ? { sequence: overrides.sequence } : {}),
  };
}

export function makeState(thread: Thread): AppState {
  const { session, latestTurn, messages, activities, ...shell } = thread;
  return {
    spaces: [],

    folders: [makeProject()],

    sidebarThreadSummaryById: {},
    threadsHydrated: true,
    threadIds: [thread.id],
    threadShellById: { [thread.id]: shell },
    threadSessionById: { [thread.id]: session },
    threadTurnStateById: { [thread.id]: { latestTurn } },
    messageIdsByThreadId: { [thread.id]: messages.map((message) => message.id) },
    messageByThreadId: {
      [thread.id]: Object.fromEntries(messages.map((message) => [message.id, message])),
    },
    activityIdsByThreadId: { [thread.id]: activities.map((activity) => activity.id) },
    activityByThreadId: {
      [thread.id]: Object.fromEntries(activities.map((activity) => [activity.id, activity])),
    },
  };
}

export function makeProject(
  overrides: Partial<AppState["folders"][number]> = {},
): AppState["folders"][number] {
  return {
    id: FolderId.makeUnsafe("project-1"),
    name: "Project",
    remoteName: "Project",
    folderName: "folder",
    localName: null,
    cwd: "/tmp/project",
    defaultModelSelection: {
      provider: "codex",
      model: "gpt-5-codex",
    },
    expanded: true,
    spaceId: TEST_SPACE_ID,
    scripts: [],
    ...overrides,
  };
}

export function makeReadModelThread(overrides: Partial<OrchestrationReadModel["threads"][number]>) {
  const id = overrides.id ?? ThreadId.makeUnsafe("thread-1");
  const thread = {
    id,
    folderId: FolderId.makeUnsafe("project-1"),
    title: "Thread",
    modelSelection: {
      provider: "codex",
      model: "gpt-5.3-codex",
    },
    latestTurn: null,
    createdAt: "2026-02-27T00:00:00.000Z",
    updatedAt: "2026-02-27T00:00:00.000Z",
    deletedAt: null,
    messages: [],
    activities: [],
    session: null,
    ...overrides,
  };
  return Object.assign({}, thread, {
    id,
  }) as OrchestrationReadModel["threads"][number];
}

export function makeReadModel(
  thread: OrchestrationReadModel["threads"][number],
): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: "2026-02-27T00:00:00.000Z",
    spaces: [],
    folders: [
      {
        id: FolderId.makeUnsafe("project-1"),
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5.3-codex",
        },
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:00.000Z",
        deletedAt: null,
        scripts: [],
        spaceId: TEST_SPACE_ID,
      },
    ],
    threads: [thread],
  };
}

export function makeStartupSnapshot(): OrchestrationStartupSnapshot {
  return {
    snapshotSequence: 2,
    spaces: [],
    folders: [
      {
        id: FolderId.makeUnsafe("project-1"),
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5.3-codex",
        },
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:00.000Z",
        scripts: [],
        spaceId: TEST_SPACE_ID,
      },
    ],
    runningThreads: [],
  };
}
export function makeReadModelProject(
  overrides: Partial<OrchestrationReadModel["folders"][number]>,
): OrchestrationReadModel["folders"][number] {
  return {
    id: FolderId.makeUnsafe("project-1"),
    title: "Project",
    workspaceRoot: "/tmp/project",
    defaultModelSelection: {
      provider: "codex",
      model: "gpt-5.3-codex",
    },
    createdAt: "2026-02-27T00:00:00.000Z",
    updatedAt: "2026-02-27T00:00:00.000Z",
    deletedAt: null,
    scripts: [],
    spaceId: TEST_SPACE_ID,
    ...overrides,
  };
}

export const threadsOf = getThreadsFromState;

export function makeThreadSummary(
  overrides: Partial<import("@penkra/contracts").CleanCoreThreadSummary> = {},
): import("@penkra/contracts").CleanCoreThreadSummary {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    spaceId: TEST_SPACE_ID,
    folderId: FolderId.makeUnsafe("project-1"),
    title: "Thread",
    provider: "codex",
    model: "gpt-5-codex",
    modelOptions: null,
    connectionId: null,
    runtimeMode: "full-access",
    state: "idle",
    activeTurnId: null,
    lastError: null,
    queue: "[]",
    createdBy: "user",
    createdByThreadId: null,
    sidebarSortOrder: null,
    lastActivityAt: null,
    lastMessagePreview: null,
    lastUserMessageAt: null,
    lastVisitedAt: null,
    openQuestionCount: 0,
    archivedAt: null,
    deletedAt: null,
    createdAt: "2026-02-13T00:00:00.000Z",
    updatedAt: "2026-02-13T00:00:00.000Z",
    ...overrides,
  };
}
