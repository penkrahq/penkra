// Purpose: Apply canonical navigation and thread shells to the window's presentation store.
import type {
  CleanCoreGetNavigationResult,
  OrchestrationSpaceShell,
  OrchestrationThreadShell,
  ThreadId,
} from "@penkra/contracts";
import { getThreadFromState } from "./threadDerivation";
import {
  arraysShallowEqual,
  normalizeProject,
  normalizeSpace,
  normalizeThreadShellSnapshot,
  resolveThreadSidebarMetadata,
  threadSessionsEqual,
  threadShellsEqual,
  threadTurnStatesEqual,
  type ProjectNormalizationInput,
} from "./storeNormalization";
import { rememberProjectLocalNames, rememberProjectUiState } from "./storePersistence";
import {
  EMPTY_THREAD_IDS,
  EMPTY_THREAD_SESSION_BY_ID,
  EMPTY_THREAD_SHELL_BY_ID,
  EMPTY_THREAD_TURN_STATE_BY_ID,
  type AppState,
} from "./storeState";
import type {
  Project,
  Space,
  SidebarThreadSummary,
  Thread,
  ThreadSession,
  ThreadShell,
  ThreadTurnState,
} from "./types";
export type ProjectMatchPolicy = "id-only";
function toThreadShell(thread: Thread): ThreadShell {
  return {
    id: thread.id,
    codexThreadId: thread.codexThreadId,
    folderId: thread.folderId,
    spaceId: thread.spaceId ?? null,
    title: thread.title,
    modelSelection: thread.modelSelection,
    ...(thread.connectionId !== undefined ? { connectionId: thread.connectionId } : {}),
    error: thread.error,
    ...(thread.errorSource !== undefined ? { errorSource: thread.errorSource } : {}),
    createdAt: thread.createdAt,
    archivedAt: thread.archivedAt ?? null,
    updatedAt: thread.updatedAt,
    creationSource: thread.creationSource ?? null,
    sourceThreadId: thread.sourceThreadId ?? null,
    subagentAgentId: thread.subagentAgentId ?? null,
    subagentNickname: thread.subagentNickname ?? null,
    subagentRole: thread.subagentRole ?? null,
    ...(thread.hasPendingUserInput !== undefined
      ? { hasPendingUserInput: thread.hasPendingUserInput }
      : {}),
    ...(thread.workStatus !== undefined ? { workStatus: thread.workStatus } : {}),
  };
}

function toThreadTurnState(thread: Thread): ThreadTurnState {
  return {
    latestTurn: thread.latestTurn,
    pendingTurnStartMessageId: thread.pendingTurnStartMessageId ?? null,
    queuedMessageIds: thread.queuedMessageIds ?? [],
  };
}

export function syncServerNavigation(
  state: AppState,
  navigation: CleanCoreGetNavigationResult,
): AppState {
  rememberProjectUiState(state.folders);
  rememberProjectLocalNames(state.folders);
  const folderIds = new Set<string>(navigation.folders.map((folder) => folder.id));
  const spaceIds = new Set(navigation.spaces.map((space) => space.id));
  let next = {
    ...state,
    folders: state.folders.filter((folder) => folderIds.has(folder.id)),
    spaces: state.spaces.filter((space) => spaceIds.has(space.id)),
  };
  for (const space of navigation.spaces) next = upsertSpace(next, space);
  for (const folder of navigation.folders) next = upsertProject(next, folder, "id-only");
  return next;
}

export function upsertProject(
  state: AppState,
  incoming: ProjectNormalizationInput,
  _matchPolicy: ProjectMatchPolicy,
): AppState {
  const existingProject = state.folders.find((project) => project.id === incoming.id);
  const nextProject = normalizeProject(incoming, existingProject);
  if (nextProject.archivedAt != null)
    return {
      ...state,
      folders: state.folders.filter((project) => project.id !== incoming.id),
    };
  if (existingProject === nextProject) return state;
  return {
    ...state,
    folders: existingProject
      ? state.folders.map((project) => (project.id === incoming.id ? nextProject : project))
      : [...state.folders, nextProject],
  };
}

export function upsertSpace(state: AppState, incoming: OrchestrationSpaceShell): AppState {
  const existing = state.spaces.find((space) => space.id === incoming.id);
  const nextSpace = normalizeSpace(incoming, existing);
  if (nextSpace.archivedAt != null) return removeSpace(state, incoming.id);
  if (existing === nextSpace) return state;
  const spaces = existing
    ? state.spaces.map((space) => (space.id === incoming.id ? nextSpace : space))
    : [...state.spaces, nextSpace];
  return {
    ...state,
    spaces: spaces.toSorted((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id)),
  };
}

export function removeSpace(state: AppState, spaceId: Space["id"]): AppState {
  const spaces = state.spaces.filter((space) => space.id !== spaceId);
  return spaces.length === state.spaces.length ? state : { ...state, spaces };
}

export function applySpaceOrder(
  state: AppState,
  orderedSpaceIds: ReadonlyArray<Space["id"]>,
  updatedAt?: string,
): AppState {
  const orderById = new Map(orderedSpaceIds.map((spaceId, index) => [spaceId, index] as const));
  const spaces = state.spaces
    .map((space) => {
      const sortOrder = orderById.get(space.id);
      return sortOrder === undefined || sortOrder === space.sortOrder
        ? space
        : {
            ...space,
            sortOrder,
            ...(updatedAt !== undefined ? { updatedAt } : {}),
          };
    })
    .toSorted((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
  return arraysShallowEqual(spaces, state.spaces) ? state : { ...state, spaces };
}

function sidebarThreadSummariesEqual(
  left: SidebarThreadSummary | undefined,
  right: SidebarThreadSummary,
): boolean {
  return (
    left !== undefined &&
    left.id === right.id &&
    left.folderId === right.folderId &&
    (left.spaceId ?? null) === (right.spaceId ?? null) &&
    left.title === right.title &&
    left.modelSelection === right.modelSelection &&
    left.session === right.session &&
    left.createdAt === right.createdAt &&
    (left.archivedAt ?? null) === (right.archivedAt ?? null) &&
    left.updatedAt === right.updatedAt &&
    left.latestTurn === right.latestTurn &&
    (left.pendingTurnStartMessageId ?? null) === (right.pendingTurnStartMessageId ?? null) &&
    (left.subagentAgentId ?? null) === (right.subagentAgentId ?? null) &&
    (left.subagentNickname ?? null) === (right.subagentNickname ?? null) &&
    (left.subagentRole ?? null) === (right.subagentRole ?? null) &&
    left.hasPendingUserInput === right.hasPendingUserInput &&
    left.workStatus === right.workStatus
  );
}

function buildSidebarThreadSummary(
  thread: Thread,
  previous?: SidebarThreadSummary,
): SidebarThreadSummary {
  const metadata = resolveThreadSidebarMetadata(thread);
  const nextSummary: SidebarThreadSummary = {
    id: thread.id,
    folderId: thread.folderId,
    spaceId: thread.spaceId ?? null,
    title: thread.title,
    modelSelection: thread.modelSelection,
    session: thread.session,
    createdAt: thread.createdAt,
    archivedAt: thread.archivedAt ?? null,
    updatedAt: thread.updatedAt,
    latestTurn: thread.latestTurn,
    pendingTurnStartMessageId: thread.pendingTurnStartMessageId ?? null,
    subagentAgentId: thread.subagentAgentId ?? null,
    subagentNickname: thread.subagentNickname ?? null,
    subagentRole: thread.subagentRole ?? null,
    hasPendingUserInput: metadata.hasPendingUserInput,
    workStatus: thread.workStatus ?? "idle",
  };
  if (previous && sidebarThreadSummariesEqual(previous, nextSummary)) {
    return previous;
  }
  return nextSummary;
}

function ensureThreadRegistered(state: AppState, threadId: ThreadId): AppState {
  const threadIds = state.threadIds ?? EMPTY_THREAD_IDS;
  if (threadIds.includes(threadId)) {
    return state;
  }
  return {
    ...state,
    threadIds: [...threadIds, threadId],
  };
}

function resolveShellEntry(previous: ThreadShell | undefined, next: ThreadShell): ThreadShell {
  return previous !== undefined && threadShellsEqual(previous, next) ? previous : next;
}

function resolveSessionEntry(
  previous: ThreadSession | null | undefined,
  next: ThreadSession | null,
): ThreadSession | undefined {
  if (next === null) {
    return undefined;
  }
  return previous != null && threadSessionsEqual(previous, next) ? previous : next;
}

function resolveTurnStateEntry(
  previous: ThreadTurnState | undefined,
  next: ThreadTurnState,
): ThreadTurnState {
  return previous !== undefined && threadTurnStatesEqual(previous, next) ? previous : next;
}

function writeThreadShellProjection(
  state: AppState,
  nextThread: {
    shell: ThreadShell;
    session: ThreadSession | null;
    turnState: ThreadTurnState;
  },
): AppState {
  const threadId = nextThread.shell.id;
  let nextState = ensureThreadRegistered(state, threadId);

  const previousShellById = nextState.threadShellById ?? EMPTY_THREAD_SHELL_BY_ID;
  const shell = resolveShellEntry(previousShellById[threadId], nextThread.shell);
  if (shell !== previousShellById[threadId]) {
    nextState = {
      ...nextState,
      threadShellById: { ...previousShellById, [threadId]: shell },
    };
  }

  const previousSessionById = nextState.threadSessionById ?? EMPTY_THREAD_SESSION_BY_ID;
  const previousSession = previousSessionById[threadId];
  const session = resolveSessionEntry(previousSession, nextThread.session);
  if (session !== previousSession) {
    const threadSessionById = { ...previousSessionById };
    if (session === undefined) {
      delete threadSessionById[threadId];
    } else {
      threadSessionById[threadId] = session;
    }
    nextState = { ...nextState, threadSessionById };
  }

  const previousTurnStateById = nextState.threadTurnStateById ?? EMPTY_THREAD_TURN_STATE_BY_ID;
  const turnState = resolveTurnStateEntry(previousTurnStateById[threadId], nextThread.turnState);
  if (turnState !== previousTurnStateById[threadId]) {
    nextState = {
      ...nextState,
      threadTurnStateById: { ...previousTurnStateById, [threadId]: turnState },
    };
  }

  return nextState;
}

function commitThreadProjection(
  state: AppState,
  threadId: ThreadId,
  options?: {
    updateSidebarSummary?: boolean;
  },
): AppState {
  const nextThread = getThreadFromState(state, threadId);
  if (!nextThread) {
    return state;
  }

  const shouldUpdateSidebarSummary = options?.updateSidebarSummary ?? true;

  const previousSummary = state.sidebarThreadSummaryById[threadId];
  const nextSummary =
    shouldUpdateSidebarSummary || previousSummary === undefined
      ? buildSidebarThreadSummary(nextThread, previousSummary)
      : previousSummary;

  if (nextSummary === previousSummary) {
    return state;
  }

  return {
    ...state,
    sidebarThreadSummaryById:
      nextSummary === previousSummary || nextSummary === undefined
        ? state.sidebarThreadSummaryById
        : {
            ...state.sidebarThreadSummaryById,
            [threadId]: nextSummary,
          },
  };
}
function removeThreadState(state: AppState, threadId: ThreadId): AppState {
  if (!state.threadShellById?.[threadId] && !state.sidebarThreadSummaryById[threadId]) return state;
  const without = <T>(record: Record<string, T> | undefined) =>
    Object.fromEntries(Object.entries(record ?? {}).filter(([id]) => id !== threadId));
  return {
    ...state,
    threadIds: (state.threadIds ?? []).filter((id) => id !== threadId),
    threadShellById: without(state.threadShellById),
    threadSessionById: without(state.threadSessionById),
    threadTurnStateById: without(state.threadTurnStateById),
    sidebarThreadSummaryById: without(state.sidebarThreadSummaryById),
  };
}
export function removeDeletedThreadFromClientState(state: AppState, threadId: ThreadId): AppState {
  return removeThreadState(state, threadId);
}
export function removeDeletedProjectFromClientState(
  state: AppState,
  folderId: Project["id"],
): AppState {
  let next = state;
  for (const shell of Object.values(state.threadShellById ?? {}))
    if (shell.folderId === folderId) next = removeThreadState(next, shell.id);
  return { ...next, folders: next.folders.filter((folder) => folder.id !== folderId) };
}
export function syncServerThreadShell(
  state: AppState,
  threadId: ThreadId,
  thread: OrchestrationThreadShell | null,
): AppState {
  if (thread === null) return removeThreadState(state, threadId);
  const previous = getThreadFromState(state, threadId);
  if (previous?.updatedAt !== undefined && previous.updatedAt > thread.updatedAt) return state;
  return commitThreadProjection(
    writeThreadShellProjection(state, normalizeThreadShellSnapshot(thread, previous)),
    threadId,
  );
}
export function applyThreadUpdate(
  state: AppState,
  threadId: ThreadId,
  updater: (thread: Thread) => Thread,
): AppState {
  const previous = getThreadFromState(state, threadId);
  if (!previous) return state;
  const next = updater(previous);
  if (next === previous) return state;
  return commitThreadProjection(
    writeThreadShellProjection(state, {
      shell: toThreadShell(next),
      session: next.session,
      turnState: toThreadTurnState(next),
    }),
    threadId,
  );
}
