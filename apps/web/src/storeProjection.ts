// FILE: storeProjection.ts
// Purpose: Owns normalized slice writes, sidebar projections, and snapshot integration.
// Exports: Pure projection transitions used by the facade and orchestration reducer.

import {
  type MessageId,
  type OrchestrationReadModel,
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamEvent,
  type OrchestrationSpaceShell,
  type ThreadId,
} from "@penkra/contracts";
import { deriveThreadSummaryMetadata } from "@penkra/shared/threadSummary";

import { getThreadFromState, getThreadsFromState } from "./threadDerivation";
import {
  arraysShallowEqual,
  capThreadActivities,
  dedupeActivitiesById,
  deepEqualJson,
  mapFolders,
  mapSpaces,
  mergeReadModelThreadDetailWithLiveHotPath,
  normalizeProject,
  normalizeSpace,
  normalizeThreadFromReadModel,
  normalizeThreadShellSnapshot,
  recordsShallowEqual,
  resolveThreadSidebarMetadata,
  threadSessionsEqual,
  threadShellsEqual,
  threadTurnStatesEqual,
  type ProjectNormalizationInput,
} from "./storeNormalization";
import { rememberProjectLocalNames, rememberProjectUiState } from "./storePersistence";
import {
  EMPTY_ACTIVITY_BY_THREAD,
  EMPTY_ACTIVITY_IDS_BY_THREAD,
  EMPTY_MESSAGE_BY_THREAD,
  EMPTY_MESSAGE_IDS_BY_THREAD,
  EMPTY_THREAD_IDS,
  EMPTY_THREAD_SESSION_BY_ID,
  EMPTY_THREAD_SHELL_BY_ID,
  EMPTY_THREAD_TURN_STATE_BY_ID,
  type AppState,
  type ThreadDetailSyncState,
} from "./storeState";
import type {
  ChatMessage,
  Project,
  Space,
  SidebarThreadSummary,
  Thread,
  ThreadSession,
  ThreadShell,
  ThreadTurnState,
} from "./types";

type ReadModelThread = OrchestrationReadModel["threads"][number];
export type ProjectMatchPolicy = "id-only";

function toThreadShell(thread: Thread): ThreadShell {
  return {
    id: thread.id,
    codexThreadId: thread.codexThreadId,
    folderId: thread.folderId,
    spaceId: thread.spaceId ?? null,
    sidebarSortOrder: thread.sidebarSortOrder ?? 0,
    title: thread.title,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    error: thread.error,
    createdAt: thread.createdAt,
    archivedAt: thread.archivedAt ?? null,
    updatedAt: thread.updatedAt,
    isPinned: thread.isPinned ?? false,
    workingDirectory: thread.workingDirectory ?? null,
    parentThreadId: thread.parentThreadId ?? null,
    creationSource: thread.creationSource ?? null,
    sourceThreadId: thread.sourceThreadId ?? null,
    subagentAgentId: thread.subagentAgentId ?? null,
    subagentNickname: thread.subagentNickname ?? null,
    subagentRole: thread.subagentRole ?? null,
    forkSourceThreadId: thread.forkSourceThreadId ?? null,
    ...(thread.pinnedMessages !== undefined ? { pinnedMessages: thread.pinnedMessages } : {}),
    ...(thread.notes !== undefined ? { notes: thread.notes } : {}),
    ...(thread.latestUserMessageAt !== undefined
      ? { latestUserMessageAt: thread.latestUserMessageAt }
      : {}),
    ...(thread.hasPendingApprovals !== undefined
      ? { hasPendingApprovals: thread.hasPendingApprovals }
      : {}),
    ...(thread.hasPendingUserInput !== undefined
      ? { hasPendingUserInput: thread.hasPendingUserInput }
      : {}),
    ...(thread.workStatus !== undefined ? { workStatus: thread.workStatus } : {}),
    ...(thread.lastMessagePreview !== undefined
      ? { lastMessagePreview: thread.lastMessagePreview }
      : {}),
    ...(thread.lastActivityAt !== undefined ? { lastActivityAt: thread.lastActivityAt } : {}),
    ...(thread.pendingInteractions !== undefined
      ? { pendingInteractions: thread.pendingInteractions }
      : {}),
    ...(thread.lastVisitedAt !== undefined ? { lastVisitedAt: thread.lastVisitedAt } : {}),
  };
}
function toThreadTurnState(thread: Thread): ThreadTurnState {
  return {
    latestTurn: thread.latestTurn,
    pendingTurnStartMessageId: thread.pendingTurnStartMessageId ?? null,
    queuedMessageIds: thread.queuedMessageIds ?? [],
  };
}

interface NormalizedSlice<TId extends string, TValue> {
  readonly ids: TId[];
  readonly byId: Record<TId, TValue>;
}

/**
 * Builds the `{ ids, byId }` pair for one thread-scoped detail slice, reusing the previous
 * containers by reference whenever they are still correct.
 *
 * Two things matter for the streaming hot path (a delta rewrites one of up to 2k messages):
 * - `ids` only changes when the order or membership changes, so it is reused by reference. That
 *   keeps the outer `...ByThreadId` record from being re-spread and keeps `collectByIds`' cache
 *   and every selector comparing slice identity from invalidating.
 * - `byId` is rebuilt in one keyed pass rather than copied from the previous record. Copying a
 *   ~2k-key dictionary object (`{ ...previous }`) measures ~5x slower in V8 than building a fresh
 *   object with the same keys, and ~4x slower than this loop.
 */
function buildNormalizedSlice<TId extends string, TValue>(
  items: readonly TValue[],
  getId: (item: TValue) => TId,
  previousItems: readonly TValue[] | undefined,
  previousIds: TId[] | undefined,
  previousById: Record<TId, TValue> | undefined,
): NormalizedSlice<TId, TValue> {
  let reusableIds: TId[] | undefined;
  if (
    previousItems !== undefined &&
    previousIds !== undefined &&
    previousById !== undefined &&
    previousItems.length === items.length &&
    previousIds.length === items.length
  ) {
    // Object identity proves a slot is untouched with a pointer compare, so a no-op rewrite of the
    // array (same contents, new reference) costs a scan instead of a rebuild.
    let firstChangedIndex = -1;
    for (let index = 0; index < items.length; index += 1) {
      if (previousItems[index] !== items[index]) {
        firstChangedIndex = index;
        break;
      }
    }
    if (firstChangedIndex < 0) {
      return { ids: previousIds, byId: previousById };
    }
    // Everything before the first changed slot is identical, so only the tail can have reordered.
    reusableIds = previousIds;
    for (let index = firstChangedIndex; index < items.length; index += 1) {
      if (previousIds[index] !== getId(items[index]!)) {
        reusableIds = undefined;
        break;
      }
    }
  }

  const byId = {} as Record<TId, TValue>;
  if (reusableIds !== undefined) {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      byId[getId(item)] = item;
    }
    return { ids: reusableIds, byId };
  }

  const ids: TId[] = new Array<TId>(items.length);
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    const id = getId(item);
    ids[index] = id;
    byId[id] = item;
  }
  return { ids, byId };
}

const messageId = (message: ChatMessage): MessageId => message.id;
const activityId = (activity: Thread["activities"][number]): string => activity.id;

export function upsertProject(
  state: AppState,
  incoming: ProjectNormalizationInput,
  _matchPolicy: ProjectMatchPolicy,
): AppState {
  if (state.deletedFolderIdsById?.[incoming.id] !== undefined) {
    return state;
  }
  const existingProject =
    state.folders.find((project) => project.id === incoming.id) ??
    (state.archivedFolders ?? []).find((project) => project.id === incoming.id);
  const nextProject = normalizeProject(incoming, existingProject);
  const belongsInArchive = nextProject.archivedAt != null;
  const folders = belongsInArchive
    ? state.folders.filter((project) => project.id !== incoming.id)
    : existingProject && state.folders.some((project) => project.id === incoming.id)
      ? state.folders.map((project) => (project.id === incoming.id ? nextProject : project))
      : [...state.folders, nextProject];
  const archivedFolders = belongsInArchive
    ? existingProject && (state.archivedFolders ?? []).some((project) => project.id === incoming.id)
      ? (state.archivedFolders ?? []).map((project) =>
          project.id === incoming.id ? nextProject : project,
        )
      : [...(state.archivedFolders ?? []), nextProject]
    : (state.archivedFolders ?? []).filter((project) => project.id !== incoming.id);
  if (folders === state.folders && archivedFolders === (state.archivedFolders ?? [])) {
    return state;
  }
  return {
    ...state,
    folders,
    archivedFolders,
  };
}

export function upsertSpace(
  state: AppState,
  incoming: OrchestrationReadModel["spaces"][number] | OrchestrationSpaceShell,
): AppState {
  const currentArchivedSpaces = state.archivedSpaces ?? [];
  const existing =
    state.spaces.find((space) => space.id === incoming.id) ??
    currentArchivedSpaces.find((space) => space.id === incoming.id);
  const nextSpace = normalizeSpace(incoming, existing);
  const existingActive = state.spaces.some((space) => space.id === incoming.id);
  const existingArchived = currentArchivedSpaces.some((space) => space.id === incoming.id);
  if (existingActive && existing === nextSpace && !existingArchived) {
    return state;
  }
  const archivedSpaces = existingArchived
    ? currentArchivedSpaces.filter((space) => space.id !== incoming.id)
    : currentArchivedSpaces;
  const spaces = existingActive
    ? state.spaces.map((space) => (space.id === incoming.id ? nextSpace : space))
    : [...state.spaces, nextSpace];
  return {
    ...state,
    spaces: spaces.toSorted(
      (left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id),
    ),
    archivedSpaces,
  };
}

export function removeSpace(
  state: AppState,
  spaceId: Space["id"],
  _assignmentUpdatedAt?: string,
  preserveAssignments = false,
): AppState {
  const currentArchivedSpaces = state.archivedSpaces ?? [];
  const spaces = state.spaces.filter((space) => space.id !== spaceId);
  if (preserveAssignments) {
    const archivedSpace = state.spaces.find((space) => space.id === spaceId);
    if (!archivedSpace) return state;
    return {
      ...state,
      spaces,
      archivedSpaces: [
        ...currentArchivedSpaces.filter((space) => space.id !== spaceId),
        archivedSpace,
      ].toSorted(
        (left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id),
      ),
    };
  }
  const archivedSpaces = currentArchivedSpaces.filter((space) => space.id !== spaceId);
  if (
    spaces.length === state.spaces.length &&
    archivedSpaces.length === currentArchivedSpaces.length
  ) {
    return state;
  }
  return {
    ...state,
    spaces,
    archivedSpaces,
  };
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
        : { ...space, sortOrder, ...(updatedAt !== undefined ? { updatedAt } : {}) };
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
    (left.sidebarSortOrder ?? 0) === (right.sidebarSortOrder ?? 0) &&
    left.title === right.title &&
    left.modelSelection === right.modelSelection &&
    (left.workingDirectory ?? null) === (right.workingDirectory ?? null) &&
    left.session === right.session &&
    left.createdAt === right.createdAt &&
    (left.archivedAt ?? null) === (right.archivedAt ?? null) &&
    left.updatedAt === right.updatedAt &&
    (left.isPinned ?? false) === (right.isPinned ?? false) &&
    left.latestTurn === right.latestTurn &&
    left.lastVisitedAt === right.lastVisitedAt &&
    (left.parentThreadId ?? null) === (right.parentThreadId ?? null) &&
    (left.subagentAgentId ?? null) === (right.subagentAgentId ?? null) &&
    (left.subagentNickname ?? null) === (right.subagentNickname ?? null) &&
    (left.subagentRole ?? null) === (right.subagentRole ?? null) &&
    left.latestUserMessageAt === right.latestUserMessageAt &&
    left.hasPendingApprovals === right.hasPendingApprovals &&
    left.hasPendingUserInput === right.hasPendingUserInput &&
    left.workStatus === right.workStatus &&
    left.lastMessagePreview === right.lastMessagePreview &&
    left.lastActivityAt === right.lastActivityAt &&
    (left.forkSourceThreadId ?? null) === (right.forkSourceThreadId ?? null)
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
    sidebarSortOrder: thread.sidebarSortOrder ?? 0,
    title: thread.title,
    modelSelection: thread.modelSelection,
    workingDirectory: thread.workingDirectory ?? null,
    session: thread.session,
    createdAt: thread.createdAt,
    archivedAt: thread.archivedAt ?? null,
    updatedAt: thread.updatedAt,
    isPinned: thread.isPinned ?? false,
    latestTurn: thread.latestTurn,
    lastVisitedAt: thread.lastVisitedAt,
    parentThreadId: thread.parentThreadId ?? null,
    subagentAgentId: thread.subagentAgentId ?? null,
    subagentNickname: thread.subagentNickname ?? null,
    subagentRole: thread.subagentRole ?? null,
    latestUserMessageAt: metadata.latestUserMessageAt,
    hasPendingApprovals: metadata.hasPendingApprovals,
    hasPendingUserInput: metadata.hasPendingUserInput,
    workStatus: thread.workStatus ?? "idle",
    lastMessagePreview: thread.lastMessagePreview ?? null,
    lastActivityAt: thread.lastActivityAt ?? null,
    forkSourceThreadId: thread.forkSourceThreadId ?? null,
  };
  if (previous && sidebarThreadSummariesEqual(previous, nextSummary)) {
    return previous;
  }
  return nextSummary;
}

/**
 * The thread-id registry a full resync should install, reusing the previous array when it already
 * says the same thing.
 *
 * Both full-sync paths used to seed `threadIds: []` and let `ensureThreadRegistered` append id by
 * id. That copied the whole array once per thread — quadratic memory traffic in the thread count —
 * and, worse, guaranteed a brand-new array reference on every single snapshot even when not one id
 * had moved. Every consumer memoizing on `state.threadIds` therefore recomputed on each snapshot,
 * and the "nothing changed" fast path in `syncServerReadModel` could never fire, because its
 * identity check on this exact field always failed.
 *
 * Seeding the finished order up front makes the loop's `ensureThreadRegistered` calls no-ops, so
 * the reference survives whenever the set and the order of threads survive.
 */
function reuseThreadIdRegistry(
  previous: ThreadId[] | undefined,
  nextThreadIds: ReadonlySet<ThreadId>,
): ThreadId[] {
  if (previous && previous.length === nextThreadIds.size) {
    let index = 0;
    let identical = true;
    for (const threadId of nextThreadIds) {
      if (previous[index] !== threadId) {
        identical = false;
        break;
      }
      index += 1;
    }
    if (identical) {
      return previous;
    }
  }
  return [...nextThreadIds];
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

function retainThreadScopedRecord<T>(
  record: Record<ThreadId, T> | undefined,
  nextThreadIds: ReadonlySet<ThreadId>,
): Record<ThreadId, T> {
  if (!record) {
    return {};
  }
  let changed = false;
  const nextRecord: Record<ThreadId, T> = {};
  for (const [threadId, value] of Object.entries(record) as [ThreadId, T][]) {
    if (!nextThreadIds.has(threadId)) {
      changed = true;
      continue;
    }
    nextRecord[threadId] = value;
  }
  return changed ? nextRecord : record;
}

/**
 * The per-entry "keep the object already stored, or take the new one" rule for the three
 * thread-keyed shell slices.
 *
 * Both writers below need it: `writeThreadShellProjection` upserts a single thread into the
 * existing records, `rebuildThreadShellRecords` builds all three from scratch for a snapshot.
 * Keeping the rule in one place is what makes their outputs comparable — a thread that did not
 * actually change has to yield the same object either way, or a snapshot arriving after an event
 * would swap references that consumers memoize on for no reason.
 */
function resolveShellEntry(previous: ThreadShell | undefined, next: ThreadShell): ThreadShell {
  return previous !== undefined && threadShellsEqual(previous, next) ? previous : next;
}

/**
 * `undefined` here means "store no key at all", not "store `undefined`".
 *
 * A thread without a session is represented by an absent key rather than an explicit `null`, so the
 * event path and the snapshot path agree on the record's shape and not just on what it says — two
 * records that differ only in that detail compare unequal and force a needless rebuild downstream.
 * `threadDerivation` reads both back as `null`.
 */
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

/**
 * Rebuilds the three thread-keyed shell records for a full snapshot in a single pass.
 *
 * `writeThreadShellProjection` is the right shape for a single upserted thread, but a full snapshot
 * used to run it once per thread against records this function had just emptied. Every equality
 * guard therefore failed by construction, so each of the three records was re-spread for every
 * thread: O(n²) property copies per snapshot. Measured on this projection, a snapshot cost 1.3 ms at
 * 200 threads, 59.5 ms at 1000 and 418 ms at 2000 — the last two are a visible main-thread stall on
 * every shell push. Accumulating into three plain objects and comparing once at the end brings the
 * same work to 0.26 ms / 2.4 ms / 4.0 ms.
 *
 * Each entry goes through the same `resolve*Entry` rule the per-thread writer uses, so the two
 * paths cannot drift: a thread that did not change keeps the object already stored, and a thread
 * without a session leaves no key behind. Reusing the previous object per entry is also what lets
 * the whole record be returned by reference when a snapshot changes nothing.
 */
function rebuildThreadShellRecords(
  state: AppState,
  snapshotThreads: readonly OrchestrationShellSnapshot["threads"][number][],
): {
  threadShellById: Record<ThreadId, ThreadShell>;
  threadSessionById: Record<ThreadId, ThreadSession | null>;
  threadTurnStateById: Record<ThreadId, ThreadTurnState>;
} {
  const previousShellById = state.threadShellById ?? EMPTY_THREAD_SHELL_BY_ID;
  const previousSessionById = state.threadSessionById ?? EMPTY_THREAD_SESSION_BY_ID;
  const previousTurnStateById = state.threadTurnStateById ?? EMPTY_THREAD_TURN_STATE_BY_ID;

  const threadShellById = {} as Record<ThreadId, ThreadShell>;
  const threadSessionById = {} as Record<ThreadId, ThreadSession | null>;
  const threadTurnStateById = {} as Record<ThreadId, ThreadTurnState>;

  for (const thread of snapshotThreads) {
    const next = normalizeThreadShellSnapshot(thread, getThreadFromState(state, thread.id));
    const threadId = next.shell.id;

    threadShellById[threadId] = resolveShellEntry(previousShellById[threadId], next.shell);

    const session = resolveSessionEntry(previousSessionById[threadId], next.session);
    if (session !== undefined) {
      threadSessionById[threadId] = session;
    }

    threadTurnStateById[threadId] = resolveTurnStateEntry(
      previousTurnStateById[threadId],
      next.turnState,
    );
  }

  return {
    threadShellById: recordsShallowEqual(previousShellById, threadShellById)
      ? previousShellById
      : threadShellById,
    threadSessionById: recordsShallowEqual(previousSessionById, threadSessionById)
      ? previousSessionById
      : threadSessionById,
    threadTurnStateById: recordsShallowEqual(previousTurnStateById, threadTurnStateById)
      ? previousTurnStateById
      : threadTurnStateById,
  };
}

function writeThreadDetailSyncState(
  state: AppState,
  threadId: ThreadId,
  syncState: ThreadDetailSyncState,
): AppState {
  if (state.threadDetailSyncById?.[threadId] === syncState) {
    return state;
  }
  return {
    ...state,
    threadDetailSyncById: {
      ...(state.threadDetailSyncById ?? {}),
      [threadId]: syncState,
    },
  };
}

function clearThreadDetailSyncState(state: AppState, threadId: ThreadId): AppState {
  if (
    state.threadDetailSyncById === undefined ||
    !Object.hasOwn(state.threadDetailSyncById, threadId)
  ) {
    return state;
  }
  const { [threadId]: _removed, ...threadDetailSyncById } = state.threadDetailSyncById;
  return { ...state, threadDetailSyncById };
}

export function markThreadDetailSyncFailedInClientState(
  state: AppState,
  threadId: ThreadId,
): AppState {
  // Applied detail outranks a late stream failure: keep rendering the data we have.
  if (state.threadDetailSyncById?.[threadId] === "synced") {
    return state;
  }
  return writeThreadDetailSyncState(state, threadId, "failed");
}

export function clearThreadDetailSyncFailureInClientState(
  state: AppState,
  threadId: ThreadId,
): AppState {
  if (state.threadDetailSyncById?.[threadId] !== "failed") {
    return state;
  }
  return clearThreadDetailSyncState(state, threadId);
}

function writeThreadState(state: AppState, nextThread: Thread, previousThread?: Thread): AppState {
  const nextShell = toThreadShell(nextThread);
  const nextTurnState = toThreadTurnState(nextThread);
  const previousShell = state.threadShellById?.[nextThread.id];
  const previousTurnState = state.threadTurnStateById?.[nextThread.id];

  let nextState = ensureThreadRegistered(state, nextThread.id);

  if (!threadShellsEqual(previousShell, nextShell)) {
    nextState = {
      ...nextState,
      threadShellById: {
        ...(nextState.threadShellById ?? EMPTY_THREAD_SHELL_BY_ID),
        [nextThread.id]: nextShell,
      },
    };
  }

  if (!threadSessionsEqual(previousThread?.session ?? null, nextThread.session)) {
    nextState = {
      ...nextState,
      threadSessionById: {
        ...(nextState.threadSessionById ?? EMPTY_THREAD_SESSION_BY_ID),
        [nextThread.id]: nextThread.session,
      },
    };
  }

  if (!threadTurnStatesEqual(previousTurnState, nextTurnState)) {
    nextState = {
      ...nextState,
      threadTurnStateById: {
        ...(nextState.threadTurnStateById ?? EMPTY_THREAD_TURN_STATE_BY_ID),
        [nextThread.id]: nextTurnState,
      },
    };
  }

  if (previousThread?.messages !== nextThread.messages) {
    const previousIds = nextState.messageIdsByThreadId?.[nextThread.id];
    const previousById = nextState.messageByThreadId?.[nextThread.id];
    const slice = buildNormalizedSlice(
      nextThread.messages,
      messageId,
      previousThread?.messages,
      previousIds,
      previousById,
    );
    if (slice.ids !== previousIds) {
      nextState = {
        ...nextState,
        messageIdsByThreadId: {
          ...(nextState.messageIdsByThreadId ?? EMPTY_MESSAGE_IDS_BY_THREAD),
          [nextThread.id]: slice.ids,
        },
      };
    }
    if (slice.byId !== previousById) {
      nextState = {
        ...nextState,
        messageByThreadId: {
          ...(nextState.messageByThreadId ?? EMPTY_MESSAGE_BY_THREAD),
          [nextThread.id]: slice.byId,
        },
      };
    }
  }

  if (previousThread?.activities !== nextThread.activities) {
    const activities = capThreadActivities(dedupeActivitiesById(nextThread.activities));
    const previousIds = nextState.activityIdsByThreadId?.[nextThread.id];
    const previousById = nextState.activityByThreadId?.[nextThread.id];
    const slice = buildNormalizedSlice(
      activities,
      activityId,
      previousThread?.activities,
      previousIds,
      previousById,
    );
    if (slice.ids !== previousIds) {
      nextState = {
        ...nextState,
        activityIdsByThreadId: {
          ...(nextState.activityIdsByThreadId ?? EMPTY_ACTIVITY_IDS_BY_THREAD),
          [nextThread.id]: slice.ids,
        },
      };
    }
    if (slice.byId !== previousById) {
      nextState = {
        ...nextState,
        activityByThreadId: {
          ...(nextState.activityByThreadId ?? EMPTY_ACTIVITY_BY_THREAD),
          [nextThread.id]: slice.byId,
        },
      };
    }
  }

  return nextState;
}

function removeThreadState(state: AppState, threadId: ThreadId): AppState {
  const { [threadId]: _removedShell, ...threadShellById } =
    state.threadShellById ?? EMPTY_THREAD_SHELL_BY_ID;
  const { [threadId]: _removedSession, ...threadSessionById } =
    state.threadSessionById ?? EMPTY_THREAD_SESSION_BY_ID;
  const { [threadId]: _removedTurnState, ...threadTurnStateById } =
    state.threadTurnStateById ?? EMPTY_THREAD_TURN_STATE_BY_ID;
  const { [threadId]: _removedMessageIds, ...messageIdsByThreadId } =
    state.messageIdsByThreadId ?? EMPTY_MESSAGE_IDS_BY_THREAD;
  const { [threadId]: _removedMessages, ...messageByThreadId } =
    state.messageByThreadId ?? EMPTY_MESSAGE_BY_THREAD;
  const { [threadId]: _removedActivityIds, ...activityIdsByThreadId } =
    state.activityIdsByThreadId ?? EMPTY_ACTIVITY_IDS_BY_THREAD;
  const { [threadId]: _removedActivities, ...activityByThreadId } =
    state.activityByThreadId ?? EMPTY_ACTIVITY_BY_THREAD;
  const { [threadId]: _removedSummary, ...sidebarThreadSummaryById } =
    state.sidebarThreadSummaryById;
  const nextThreadIds = (state.threadIds ?? EMPTY_THREAD_IDS).filter((id) => id !== threadId);

  if (
    nextThreadIds === state.threadIds &&
    sidebarThreadSummaryById === state.sidebarThreadSummaryById
  ) {
    return clearThreadDetailSyncState(state, threadId);
  }

  return clearThreadDetailSyncState(
    {
      ...state,
      threadIds: nextThreadIds,
      threadShellById,
      threadSessionById,
      threadTurnStateById,
      messageIdsByThreadId,
      messageByThreadId,
      activityIdsByThreadId,
      activityByThreadId,
      sidebarThreadSummaryById,
    },
    threadId,
  );
}

export function evictThreadDetailFromClientState(state: AppState, threadId: ThreadId): AppState {
  const detailRecords = [
    state.messageIdsByThreadId,
    state.messageByThreadId,
    state.activityIdsByThreadId,
    state.activityByThreadId,
  ];
  const hasNormalizedDetail = detailRecords.some(
    (record) => record !== undefined && Object.hasOwn(record, threadId),
  );
  if (!hasNormalizedDetail) {
    // A sync flag without normalized detail is stale; clear it so hydration restarts cleanly.
    return clearThreadDetailSyncState(state, threadId);
  }

  const { [threadId]: _removedMessageIds, ...messageIdsByThreadId } =
    state.messageIdsByThreadId ?? EMPTY_MESSAGE_IDS_BY_THREAD;
  const { [threadId]: _removedMessages, ...messageByThreadId } =
    state.messageByThreadId ?? EMPTY_MESSAGE_BY_THREAD;
  const { [threadId]: _removedActivityIds, ...activityIdsByThreadId } =
    state.activityIdsByThreadId ?? EMPTY_ACTIVITY_IDS_BY_THREAD;
  const { [threadId]: _removedActivities, ...activityByThreadId } =
    state.activityByThreadId ?? EMPTY_ACTIVITY_BY_THREAD;

  return clearThreadDetailSyncState(
    {
      ...state,
      messageIdsByThreadId,
      messageByThreadId,
      activityIdsByThreadId,
      activityByThreadId,
    },
    threadId,
  );
}

/**
 * Sequence at (or after) which a deletion is guaranteed to be reflected in server snapshots.
 * When the deletion arrives as a domain event we know it exactly; for optimistic client-side
 * deletes we only have a lower bound — the delete cannot have been recorded before the newest
 * snapshot we have already integrated, so `shellSnapshotSequence + 1` is safe. Re-deleting keeps
 * the highest known sequence, because retiring later is always the safe direction.
 */
function nextTombstoneSequence<TId extends string>(
  tombstones: Record<TId, number> | undefined,
  id: TId,
  state: AppState,
  deletedAtSequence: number | undefined,
): number {
  const candidate = deletedAtSequence ?? (state.shellSnapshotSequence ?? 0) + 1;
  const existing = tombstones?.[id];
  return existing === undefined ? candidate : Math.max(existing, candidate);
}

/**
 * Retires tombstones the late-snapshot guard no longer needs.
 *
 * A tombstone only has to survive until an authoritative snapshot generated at or after the
 * deletion proves the row is gone. Snapshots older than that can still carry the deleted row, so
 * they must never retire it; that is what keeps the resurrection guard intact.
 */
function retireDeletionTombstones<TId extends string>(
  tombstones: Record<TId, number> | undefined,
  snapshotSequence: number,
  presentIds: ReadonlySet<string>,
): Record<TId, number> | undefined {
  if (tombstones === undefined) {
    return tombstones;
  }
  let retiredAny = false;
  const retained = {} as Record<TId, number>;
  for (const [id, deletedAtSequence] of Object.entries(tombstones) as [TId, number][]) {
    if (snapshotSequence >= deletedAtSequence && !presentIds.has(id)) {
      retiredAny = true;
      continue;
    }
    retained[id] = deletedAtSequence;
  }
  return retiredAny ? retained : tombstones;
}

/**
 * True when `snapshotSequence` predates the newest snapshot we have already integrated.
 *
 * Such a snapshot can still carry rows deleted after it was generated, and the tombstone that
 * would have filtered them may already have been retired by the newer snapshot — at which point
 * the row silently comes back. The tombstone map cannot tell "never deleted" from "deleted and
 * already confirmed gone", so the whole stale payload has to be rejected before it is merged.
 */
function isStaleSnapshot(state: AppState, snapshotSequence: number): boolean {
  return snapshotSequence < (state.shellSnapshotSequence ?? 0);
}

/**
 * Drops thread/project tombstones that `snapshot` has authoritatively confirmed absent.
 *
 * The sequence guard here only keeps retirement honest; it is not what stops a stale snapshot from
 * resurrecting a row. That is `isStaleSnapshot`, applied before any merge happens.
 */
function retireConfirmedDeletionTombstones(
  state: AppState,
  snapshotSequence: number,
  presentThreadIds: ReadonlySet<string>,
  presentFolderIds: ReadonlySet<string>,
): AppState {
  if (snapshotSequence < (state.shellSnapshotSequence ?? 0)) {
    return state;
  }
  const deletedThreadIdsById = retireDeletionTombstones(
    state.deletedThreadIdsById,
    snapshotSequence,
    presentThreadIds,
  );
  const deletedFolderIdsById = retireDeletionTombstones(
    state.deletedFolderIdsById,
    snapshotSequence,
    presentFolderIds,
  );
  if (
    deletedThreadIdsById === state.deletedThreadIdsById &&
    deletedFolderIdsById === state.deletedFolderIdsById
  ) {
    return state;
  }
  return {
    ...state,
    ...(deletedThreadIdsById !== undefined ? { deletedThreadIdsById } : {}),
    ...(deletedFolderIdsById !== undefined ? { deletedFolderIdsById } : {}),
  };
}

export function removeDeletedThreadFromClientState(
  state: AppState,
  threadId: ThreadId,
  deletedAtSequence?: number,
): AppState {
  const sequence = nextTombstoneSequence(
    state.deletedThreadIdsById,
    threadId,
    state,
    deletedAtSequence,
  );
  const deletedThreadIdsById =
    state.deletedThreadIdsById?.[threadId] === sequence
      ? state.deletedThreadIdsById
      : {
          ...(state.deletedThreadIdsById ?? {}),
          [threadId]: sequence,
        };
  const nextState = removeThreadState(state, threadId);
  return nextState.deletedThreadIdsById === deletedThreadIdsById
    ? nextState
    : {
        ...nextState,
        deletedThreadIdsById,
      };
}

function removeProjectState(state: AppState, folderId: Project["id"]): AppState {
  const threadIds = new Set<ThreadId>();
  for (const shell of Object.values(state.threadShellById ?? EMPTY_THREAD_SHELL_BY_ID)) {
    if (shell.folderId === folderId) {
      threadIds.add(shell.id);
    }
  }

  const nextFolders = state.folders.some((project) => project.id === folderId)
    ? state.folders.filter((project) => project.id !== folderId)
    : state.folders;
  const currentArchivedFolders = state.archivedFolders ?? [];
  const nextArchivedFolders = currentArchivedFolders.some((project) => project.id === folderId)
    ? currentArchivedFolders.filter((project) => project.id !== folderId)
    : currentArchivedFolders;
  const nextState = [...threadIds].reduce((currentState, threadId) => {
    return removeThreadState(currentState, threadId);
  }, state);

  if (
    nextFolders === state.folders &&
    nextArchivedFolders === currentArchivedFolders &&
    nextState === state
  ) {
    return state;
  }
  return {
    ...nextState,
    folders: nextFolders,
    archivedFolders: nextArchivedFolders,
  };
}

export function removeDeletedProjectFromClientState(
  state: AppState,
  folderId: Project["id"],
  deletedAtSequence?: number,
): AppState {
  const sequence = nextTombstoneSequence(
    state.deletedFolderIdsById,
    folderId,
    state,
    deletedAtSequence,
  );
  const deletedFolderIdsById =
    state.deletedFolderIdsById?.[folderId] === sequence
      ? state.deletedFolderIdsById
      : {
          ...(state.deletedFolderIdsById ?? {}),
          [folderId]: sequence,
        };
  const nextState = removeProjectState(state, folderId);
  return nextState.deletedFolderIdsById === deletedFolderIdsById
    ? nextState
    : {
        ...nextState,
        deletedFolderIdsById,
      };
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

function deriveThreadStateSignals(
  thread: Thread,
): Pick<Thread, "latestUserMessageAt" | "hasPendingApprovals" | "hasPendingUserInput"> {
  const metadata = deriveThreadSummaryMetadata({
    messages: thread.messages,
    activities: thread.activities,
  });
  const actionableInteractions = thread.pendingInteractions?.filter(
    (interaction) => interaction.status === "pending" || interaction.status === "retryable",
  );
  return {
    latestUserMessageAt: metadata.latestUserMessageAt,
    hasPendingApprovals:
      actionableInteractions?.some((interaction) => interaction.interactionKind === "approval") ??
      metadata.hasPendingApprovals,
    hasPendingUserInput:
      actionableInteractions?.some((interaction) => interaction.interactionKind === "userInput") ??
      metadata.hasPendingUserInput,
  };
}

function withDerivedThreadStateSignals(thread: Thread): Thread {
  const nextSignals = deriveThreadStateSignals(thread);
  if (
    thread.latestUserMessageAt === nextSignals.latestUserMessageAt &&
    thread.hasPendingApprovals === nextSignals.hasPendingApprovals &&
    thread.hasPendingUserInput === nextSignals.hasPendingUserInput
  ) {
    return thread;
  }
  return {
    ...thread,
    ...nextSignals,
  };
}

export function applyThreadUpdate(
  state: AppState,
  threadId: ThreadId,
  updater: (thread: Thread) => Thread,
  options?: {
    recomputeSummarySignals?: boolean;
    updateSidebarSummary?: boolean;
  },
): AppState {
  const currentThread = getThreadFromState(state, threadId);
  if (!currentThread) {
    return state;
  }
  const updatedThread =
    options?.recomputeSummarySignals === false
      ? updater(currentThread)
      : withDerivedThreadStateSignals(updater(currentThread));
  if (updatedThread === currentThread) {
    return state;
  }
  return commitThreadProjection(writeThreadState(state, updatedThread, currentThread), threadId, {
    updateSidebarSummary: options?.updateSidebarSummary ?? true,
  });
}

export function syncServerShellSnapshot(
  state: AppState,
  snapshot: OrchestrationShellSnapshot,
): AppState {
  if (isStaleSnapshot(state, snapshot.snapshotSequence)) {
    return state;
  }
  rememberProjectUiState(state.folders);
  rememberProjectLocalNames(state.folders);
  const deletedFolderIdsById = state.deletedFolderIdsById ?? {};
  const deletedThreadIdsById = state.deletedThreadIdsById ?? {};
  const snapshotThreads = snapshot.threads.filter(
    (thread) =>
      deletedFolderIdsById[thread.folderId] === undefined &&
      deletedThreadIdsById[thread.id] === undefined,
  );
  const snapshotFolders = snapshot.folders.filter(
    (project) => deletedFolderIdsById[project.id] === undefined,
  );
  const snapshotArchivedFolders = (snapshot.archivedFolders ?? []).filter(
    (project) => deletedFolderIdsById[project.id] === undefined,
  );
  const spaces = mapSpaces(snapshot.spaces ?? [], state.spaces ?? []);
  const archivedSpaces = mapSpaces(snapshot.archivedSpaces ?? [], state.archivedSpaces ?? []);
  const folders = mapFolders(snapshotFolders, state.folders);
  const archivedFolders = mapFolders(snapshotArchivedFolders, state.archivedFolders ?? []);
  const nextThreadIds = new Set(snapshotThreads.map((thread) => thread.id));

  const normalizedState: AppState = {
    ...state,
    threadIds: reuseThreadIdRegistry(state.threadIds, nextThreadIds),
    ...rebuildThreadShellRecords(state, snapshotThreads),
    messageIdsByThreadId: retainThreadScopedRecord(state.messageIdsByThreadId, nextThreadIds),
    messageByThreadId: retainThreadScopedRecord(state.messageByThreadId, nextThreadIds),
    activityIdsByThreadId: retainThreadScopedRecord(state.activityIdsByThreadId, nextThreadIds),
    activityByThreadId: retainThreadScopedRecord(state.activityByThreadId, nextThreadIds),
    threadDetailSyncById: retainThreadScopedRecord(state.threadDetailSyncById, nextThreadIds),
  };

  const threads = getThreadsFromState(normalizedState);
  const nextSidebarThreadSummaryById = Object.fromEntries(
    threads.map((thread) => [
      thread.id,
      buildSidebarThreadSummary(thread, state.sidebarThreadSummaryById[thread.id]),
    ]),
  ) as Record<string, SidebarThreadSummary>;
  const sidebarThreadSummaryById = recordsShallowEqual(
    state.sidebarThreadSummaryById,
    nextSidebarThreadSummaryById,
  )
    ? state.sidebarThreadSummaryById
    : nextSidebarThreadSummaryById;

  return retireConfirmedDeletionTombstones(
    {
      ...normalizedState,
      shellSnapshotSequence: Math.max(state.shellSnapshotSequence ?? 0, snapshot.snapshotSequence),
      spaces,
      archivedSpaces,
      folders,
      archivedFolders,
      sidebarThreadSummaryById,
      threadsHydrated: true,
    },
    snapshot.snapshotSequence,
    new Set(snapshot.threads.map((thread) => thread.id)),
    new Set(snapshot.folders.map((project) => project.id)),
  );
}

function syncServerThreadDetailWithOptions(
  state: AppState,
  thread: ReadModelThread,
  options?: {
    mergeLiveHotPath?: boolean;
  },
): AppState {
  const previousThread = getThreadFromState(state, thread.id);
  const nextThreadDetail =
    options?.mergeLiveHotPath === true
      ? mergeReadModelThreadDetailWithLiveHotPath(thread, previousThread)
      : thread;
  return writeThreadDetailSyncState(
    commitThreadProjection(
      writeThreadState(
        state,
        normalizeThreadFromReadModel(nextThreadDetail, previousThread),
        previousThread,
      ),
      thread.id,
      {
        updateSidebarSummary: false,
      },
    ),
    thread.id,
    "synced",
  );
}

export function syncServerThreadDetail(state: AppState, thread: ReadModelThread): AppState {
  if (
    state.deletedFolderIdsById?.[thread.folderId] !== undefined ||
    state.deletedThreadIdsById?.[thread.id] !== undefined
  ) {
    return removeThreadState(state, thread.id);
  }
  return syncServerThreadDetailWithOptions(state, thread);
}

export function syncServerThreadDetailHotPath(state: AppState, thread: ReadModelThread): AppState {
  if (
    state.deletedFolderIdsById?.[thread.folderId] !== undefined ||
    state.deletedThreadIdsById?.[thread.id] !== undefined
  ) {
    return removeThreadState(state, thread.id);
  }
  return syncServerThreadDetailWithOptions(state, thread, {
    mergeLiveHotPath: true,
  });
}

export function applyShellEvent(state: AppState, event: OrchestrationShellStreamEvent): AppState {
  let nextState: AppState;
  switch (event.kind) {
    case "space-upserted":
      nextState = upsertSpace(state, event.space);
      break;
    case "space-removed":
      nextState = removeSpace(
        state,
        event.spaceId,
        event.updatedAt,
        event.preserveAssignments ?? false,
      );
      break;
    case "space-order-updated":
      nextState = applySpaceOrder(state, event.orderedSpaceIds);
      break;
    case "sidebar-layout-updated": {
      nextState = state;
      for (const project of event.folders) {
        nextState = upsertProject(nextState, project, "id-only");
      }
      for (const thread of event.threads) {
        if (
          nextState.deletedFolderIdsById?.[thread.folderId] !== undefined ||
          nextState.deletedThreadIdsById?.[thread.id] !== undefined
        ) {
          nextState = removeThreadState(nextState, thread.id);
          continue;
        }
        nextState = commitThreadProjection(
          writeThreadShellProjection(
            nextState,
            normalizeThreadShellSnapshot(thread, getThreadFromState(nextState, thread.id)),
          ),
          thread.id,
        );
      }
      break;
    }
    case "folder-upserted":
      nextState = upsertProject(state, event.folder, "id-only");
      break;
    case "folder-removed":
      nextState = removeDeletedProjectFromClientState(state, event.folderId, event.sequence);
      break;
    case "thread-upserted": {
      if (
        state.deletedFolderIdsById?.[event.thread.folderId] !== undefined ||
        state.deletedThreadIdsById?.[event.thread.id] !== undefined
      ) {
        nextState = removeThreadState(state, event.thread.id);
        break;
      }
      nextState = writeThreadShellProjection(
        state,
        normalizeThreadShellSnapshot(event.thread, getThreadFromState(state, event.thread.id)),
      );
      nextState = commitThreadProjection(nextState, event.thread.id);
      break;
    }
    case "thread-removed":
      // Shell removals can be retryable draft rollbacks; explicit delete reconciliation owns tombstones.
      nextState = removeThreadState(state, event.threadId);
      break;
  }
  const shellSnapshotSequence = Math.max(state.shellSnapshotSequence ?? 0, event.sequence);
  return nextState.shellSnapshotSequence === shellSnapshotSequence
    ? nextState
    : { ...nextState, shellSnapshotSequence };
}

export function syncServerReadModel(state: AppState, readModel: OrchestrationReadModel): AppState {
  if (isStaleSnapshot(state, readModel.snapshotSequence)) {
    return state;
  }
  rememberProjectUiState(state.folders);
  rememberProjectLocalNames(state.folders);
  const deletedFolderIdsById = state.deletedFolderIdsById ?? {};
  const deletedThreadIdsById = state.deletedThreadIdsById ?? {};
  // Ids the server still reports as live at this snapshot sequence; anything else is either
  // absent or server-side soft-deleted, which is what lets a tombstone retire safely.
  const livePresentThreadIds = new Set<string>(
    readModel.threads.filter((thread) => thread.deletedAt === null).map((thread) => thread.id),
  );
  const livePresentFolderIds = new Set<string>(
    readModel.folders.filter((project) => project.deletedAt === null).map((project) => project.id),
  );
  const spaces = mapSpaces(
    (readModel.spaces ?? []).filter(
      (space) => space.deletedAt === null && space.archivedAt === null,
    ),
    state.spaces ?? [],
  );
  const archivedSpaces = mapSpaces(
    (readModel.spaces ?? []).filter(
      (space) => space.deletedAt === null && space.archivedAt !== null,
    ),
    state.archivedSpaces ?? [],
  );
  const folders = mapFolders(
    readModel.folders.filter(
      (project) =>
        project.deletedAt === null &&
        project.archivedAt == null &&
        deletedFolderIdsById[project.id] === undefined,
    ),
    state.folders,
  );
  const archivedFolders = mapFolders(
    readModel.folders.filter(
      (project) =>
        project.deletedAt === null &&
        project.archivedAt != null &&
        deletedFolderIdsById[project.id] === undefined,
    ),
    state.archivedFolders ?? [],
  );
  const nextThreads = readModel.threads
    .filter(
      (thread) =>
        thread.deletedAt === null &&
        deletedFolderIdsById[thread.folderId] === undefined &&
        deletedThreadIdsById[thread.id] === undefined,
    )
    .map((thread) => {
      const existing = getThreadFromState(state, thread.id);
      return normalizeThreadFromReadModel(thread, existing);
    });
  const nextThreadIds = new Set(nextThreads.map((thread) => thread.id));
  let normalizedState: AppState = {
    ...state,
    threadIds: reuseThreadIdRegistry(state.threadIds, nextThreadIds),
    threadShellById: retainThreadScopedRecord(state.threadShellById, nextThreadIds),
    threadSessionById: retainThreadScopedRecord(state.threadSessionById, nextThreadIds),
    threadTurnStateById: retainThreadScopedRecord(state.threadTurnStateById, nextThreadIds),
    messageIdsByThreadId: retainThreadScopedRecord(state.messageIdsByThreadId, nextThreadIds),
    messageByThreadId: retainThreadScopedRecord(state.messageByThreadId, nextThreadIds),
    activityIdsByThreadId: retainThreadScopedRecord(state.activityIdsByThreadId, nextThreadIds),
    activityByThreadId: retainThreadScopedRecord(state.activityByThreadId, nextThreadIds),
    threadDetailSyncById: retainThreadScopedRecord(state.threadDetailSyncById, nextThreadIds),
  };
  for (const thread of nextThreads) {
    // Read-model threads carry full detail (messages, activities), so they are synced by definition.
    // The previous thread is a cache hit here (it was already materialized above) and lets the
    // slice writer reuse untouched ids/records instead of rebuilding them.
    normalizedState = writeThreadDetailSyncState(
      writeThreadState(normalizedState, thread, getThreadFromState(state, thread.id)),
      thread.id,
      "synced",
    );
  }
  const threads = getThreadsFromState(normalizedState);
  const nextSidebarThreadSummaryById = Object.fromEntries(
    threads.map((thread) => [
      thread.id,
      buildSidebarThreadSummary(thread, state.sidebarThreadSummaryById[thread.id]),
    ]),
  ) as Record<string, SidebarThreadSummary>;
  const sidebarThreadSummaryById = recordsShallowEqual(
    state.sidebarThreadSummaryById,
    nextSidebarThreadSummaryById,
  )
    ? state.sidebarThreadSummaryById
    : nextSidebarThreadSummaryById;
  if (
    spaces === state.spaces &&
    archivedSpaces === state.archivedSpaces &&
    folders === state.folders &&
    archivedFolders === (state.archivedFolders ?? []) &&
    sidebarThreadSummaryById === state.sidebarThreadSummaryById &&
    normalizedState.threadIds === state.threadIds &&
    normalizedState.threadShellById === state.threadShellById &&
    normalizedState.threadSessionById === state.threadSessionById &&
    normalizedState.threadTurnStateById === state.threadTurnStateById &&
    normalizedState.messageIdsByThreadId === state.messageIdsByThreadId &&
    normalizedState.messageByThreadId === state.messageByThreadId &&
    normalizedState.activityIdsByThreadId === state.activityIdsByThreadId &&
    normalizedState.activityByThreadId === state.activityByThreadId &&
    normalizedState.threadDetailSyncById === state.threadDetailSyncById &&
    state.threadsHydrated
  ) {
    // Nothing to merge, but the snapshot is still authoritative at its own sequence. Recording it
    // keeps `shellSnapshotSequence` honest, which is what later optimistic deletes derive their
    // tombstone lower bound from — otherwise a tombstone created after this point could be retired
    // by a snapshot that predates the deletion.
    const advanced =
      readModel.snapshotSequence > (state.shellSnapshotSequence ?? 0)
        ? { ...state, shellSnapshotSequence: readModel.snapshotSequence }
        : state;
    return retireConfirmedDeletionTombstones(
      advanced,
      readModel.snapshotSequence,
      livePresentThreadIds,
      livePresentFolderIds,
    );
  }
  return retireConfirmedDeletionTombstones(
    {
      ...normalizedState,
      shellSnapshotSequence: Math.max(state.shellSnapshotSequence ?? 0, readModel.snapshotSequence),
      spaces,
      archivedSpaces,
      folders,
      archivedFolders,
      sidebarThreadSummaryById,
      threadsHydrated: true,
    },
    readModel.snapshotSequence,
    livePresentThreadIds,
    livePresentFolderIds,
  );
}
