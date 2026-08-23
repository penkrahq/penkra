import type { OrchestrationEvent, OrchestrationReadModel, ThreadId } from "@penkra/contracts";
import {
  ORCHESTRATION_THREAD_HYDRATION_LIMITS,
  OrchestrationMessage,
  OrchestrationSession,
  OrchestrationThread,
  ThreadMessageDeliverySetPayload,
} from "@penkra/contracts";
import {
  addPinnedMessage,
  removePinnedMessage,
  setPinnedMessageDone,
  setPinnedMessageLabel,
} from "@penkra/shared/pinnedMessages";
import {
  addThreadMarker,
  removeThreadMarker,
  setThreadMarkerDone,
  setThreadMarkerLabel,
} from "@penkra/shared/threadMarkers";
import { Effect, Schema } from "effect";

import { toProjectorDecodeError, type OrchestrationProjectorDecodeError } from "./Errors.ts";
import {
  MessageSentPayloadSchema,
  SpaceCreatedPayload,
  SpaceArchivedPayload,
  SpaceDeletedPayload,
  SpaceUpdatedPayload,
  SpaceRestoredPayload,
  FolderCreatedPayload,
  FolderDeletedPayload,
  FolderMovedPayload,
  FolderUpdatedPayload,
  ThreadArchivedPayload,
  ThreadActivityAppendedPayload,
  ThreadCreatedPayload,
  ThreadDeletedPayload,
  ThreadUpdatedPayload,
  ThreadPinnedMessageAddedPayload,
  ThreadPinnedMessageDoneSetPayload,
  ThreadPinnedMessageLabelSetPayload,
  ThreadPinnedMessageRemovedPayload,
  ThreadMarkerAddedPayload,
  ThreadMarkerDoneSetPayload,
  ThreadMarkerLabelSetPayload,
  ThreadMarkerRemovedPayload,
  ThreadConversationRolledBackPayload,
  ThreadRuntimeModeSetPayload,
  ThreadUnarchivedPayload,
  ThreadSessionSetPayload,
  ThreadTurnStartRequestedPayload,
  ThreadTurnStartCancelledPayload,
} from "./Schemas.ts";
import { resolveStableMessageTurnId } from "./messageTurnId.ts";
import { settleTurnStateFromSession } from "./turnLifecycle.ts";
import { deriveTurnStartModelSelection, deriveTurnStartSession } from "./turnStartSession.ts";

type ThreadPatch = Partial<Omit<OrchestrationThread, "id" | "folderId">>;
const MAX_THREAD_MESSAGES = ORCHESTRATION_THREAD_HYDRATION_LIMITS.messages;
const MAX_THREAD_ACTIVITIES = ORCHESTRATION_THREAD_HYDRATION_LIMITS.summaryActivities;

function isTerminalLatestTurn(
  latestTurn: OrchestrationThread["latestTurn"] | null | undefined,
): boolean {
  if (!latestTurn?.completedAt) {
    return false;
  }
  return latestTurn.state === "completed" || latestTurn.state === "error";
}

// Turn lifecycle must settle with the session: once a session leaves "running",
// no provider event will ever mark the turn complete on its own, so a running
// latestTurn is settled here.
// A retained activeTurnId blocks settlement (except on error): stop-requested flows
// deliberately emit "interrupted" while keeping the turn active until the provider's
// terminal event decides the real outcome, and a premature settle here could never
// be corrected because settlement only applies to running turns.
function settleLatestTurnForSessionStatus(
  latestTurn: OrchestrationThread["latestTurn"],
  session: Pick<OrchestrationSession, "status" | "activeTurnId" | "updatedAt">,
): OrchestrationThread["latestTurn"] {
  if (latestTurn?.state !== "running") {
    return latestTurn;
  }
  const settledState = settleTurnStateFromSession(session, latestTurn.state);
  if (settledState === null) {
    return latestTurn;
  }
  return {
    ...latestTurn,
    state: settledState,
    completedAt: latestTurn.completedAt ?? session.updatedAt,
  };
}

// Every projected event patches exactly one thread, and streaming assistant
// deltas run this on the dispatch hot path, so patch the single affected slot
// instead of mapping a closure over every thread.
function updateThread(
  threads: ReadonlyArray<OrchestrationThread>,
  threadId: ThreadId,
  patch: ThreadPatch,
): OrchestrationThread[] {
  const nextThreads = threads.slice();
  const index = nextThreads.findIndex((thread) => thread.id === threadId);
  if (index === -1) {
    return nextThreads;
  }
  const updated = { ...nextThreads[index]!, ...patch };
  nextThreads[index] =
    updated.session?.status === "starting" && updated.pendingTurnStartMessageId == null
      ? {
          ...updated,
          pendingTurnStartMessageId:
            updated.messages.findLast((message) => message.role === "user")?.id ?? null,
        }
      : updated;
  return nextThreads;
}

// Message ids are unique within a thread and streamed deltas land on the newest
// message, so searching backwards finds the target in one step instead of
// scanning the whole (capped at MAX_THREAD_MESSAGES) transcript.
function findMessageIndexFromEnd(
  messages: ReadonlyArray<OrchestrationMessage>,
  messageId: string,
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.id === messageId) {
      return index;
    }
  }
  return -1;
}

function decodeForEvent<A>(
  schema: Schema.Schema<A>,
  value: unknown,
  eventType: OrchestrationEvent["type"],
  field: string,
): Effect.Effect<A, OrchestrationProjectorDecodeError> {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(schema as any)(value),
    catch: (error) => toProjectorDecodeError(`${eventType}:${field}`)(error as Schema.SchemaError),
  });
}

function rollbackThreadMessagesFromMessage(
  messages: ReadonlyArray<OrchestrationMessage>,
  messageId: string,
  preserveTarget: boolean,
): {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly removedTurnIds: ReadonlySet<string>;
} {
  const targetIndex = messages.findIndex((message) => message.id === messageId);
  if (targetIndex < 0) {
    return { messages, removedTurnIds: new Set() };
  }

  const removedMessages = messages.slice(targetIndex);
  const preservedTarget = preserveTarget
    ? [{ ...messages[targetIndex]!, turnId: null, delivery: undefined }]
    : [];
  return {
    messages: [...messages.slice(0, targetIndex), ...preservedTarget],
    removedTurnIds: new Set(
      removedMessages.flatMap((message) => (message.turnId === null ? [] : [message.turnId])),
    ),
  };
}

function compareThreadActivities(
  left: OrchestrationThread["activities"][number],
  right: OrchestrationThread["activities"][number],
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function upsertThreadActivity(
  activities: ReadonlyArray<OrchestrationThread["activities"][number]>,
  activity: OrchestrationThread["activities"][number],
): ReadonlyArray<OrchestrationThread["activities"][number]> {
  const existingIndex = activities.findIndex((entry) => entry.id === activity.id);
  if (existingIndex >= 0 && compareThreadActivities(activities[existingIndex]!, activity) === 0) {
    const next = [...activities];
    next[existingIndex] = activity;
    return next.slice(-MAX_THREAD_ACTIVITIES);
  }

  const withoutExisting =
    existingIndex < 0
      ? activities
      : [...activities.slice(0, existingIndex), ...activities.slice(existingIndex + 1)];
  const last = withoutExisting.at(-1);
  if (!last || compareThreadActivities(last, activity) <= 0) {
    return [...withoutExisting, activity].slice(-MAX_THREAD_ACTIVITIES);
  }

  let low = 0;
  let high = withoutExisting.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (compareThreadActivities(withoutExisting[middle]!, activity) <= 0) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return [...withoutExisting.slice(0, low), activity, ...withoutExisting.slice(low)].slice(
    -MAX_THREAD_ACTIVITIES,
  );
}

export function createEmptyReadModel(nowIso: string): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    spaces: [],
    folders: [],
    threads: [],
    updatedAt: nowIso,
  };
}

export function projectEvent(
  model: OrchestrationReadModel,
  event: OrchestrationEvent,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  const nextBase: OrchestrationReadModel = {
    ...model,
    snapshotSequence: event.sequence,
    updatedAt: event.occurredAt,
  };

  switch (event.type) {
    case "space.created":
      return decodeForEvent(SpaceCreatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const existing = nextBase.spaces.find((entry) => entry.id === payload.spaceId);
          const nextSpace = {
            id: payload.spaceId,
            name: payload.name,
            icon: payload.icon,
            sortOrder: payload.sortOrder,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
            archivedAt: null,
            deletedAt: null,
          };
          return {
            ...nextBase,
            spaces: existing
              ? nextBase.spaces.map((entry) => (entry.id === payload.spaceId ? nextSpace : entry))
              : [...nextBase.spaces, nextSpace],
          };
        }),
      );

    case "space.updated":
      return decodeForEvent(SpaceUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const orderBySpaceId = new Map(
            (payload.orderedSpaceIds ?? []).map((spaceId, index) => [spaceId, index] as const),
          );
          return {
            ...nextBase,
            spaces: nextBase.spaces.map((space) => {
              const sortOrder = orderBySpaceId.get(space.id);
              if (space.id === payload.spaceId) {
                return {
                  ...space,
                  ...(payload.name !== undefined ? { name: payload.name } : {}),
                  ...(payload.icon !== undefined ? { icon: payload.icon } : {}),
                  ...(sortOrder !== undefined ? { sortOrder } : {}),
                  updatedAt: payload.updatedAt,
                };
              }
              return sortOrder === undefined || sortOrder === space.sortOrder
                ? space
                : { ...space, sortOrder, updatedAt: payload.updatedAt };
            }),
          };
        }),
      );

    case "space.deleted":
      return decodeForEvent(SpaceDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          spaces: nextBase.spaces.map((space) =>
            space.id === payload.spaceId
              ? { ...space, deletedAt: payload.deletedAt, updatedAt: payload.deletedAt }
              : space,
          ),
        })),
      );

    case "space.archived":
      return decodeForEvent(SpaceArchivedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          spaces: nextBase.spaces.map((space) =>
            space.id === payload.spaceId
              ? { ...space, archivedAt: payload.archivedAt, updatedAt: payload.archivedAt }
              : space,
          ),
        })),
      );

    case "space.restored":
      return decodeForEvent(SpaceRestoredPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          spaces: nextBase.spaces.map((space) =>
            space.id === payload.spaceId
              ? {
                  ...space,
                  name: payload.name ?? space.name,
                  archivedAt: null,
                  updatedAt: payload.restoredAt,
                }
              : space,
          ),
        })),
      );

    case "sidebar.layout-updated": {
      const folderUpdates = new Map(
        event.payload.folderUpdates.map((update) => [update.folderId, update] as const),
      );
      const threadUpdates = new Map(
        event.payload.threadUpdates.map((update) => [update.threadId, update] as const),
      );
      return Effect.succeed({
        ...nextBase,
        folders: nextBase.folders.map((folder) => {
          const update = folderUpdates.get(folder.id);
          return update
            ? {
                ...folder,
                ...(update.sidebarSortOrder !== undefined
                  ? { sidebarSortOrder: update.sidebarSortOrder }
                  : {}),
                updatedAt: event.payload.updatedAt,
              }
            : folder;
        }),
        threads: nextBase.threads.map((thread) => {
          const update = threadUpdates.get(thread.id);
          return update
            ? {
                ...thread,
                ...(update.folderId !== undefined ? { folderId: update.folderId } : {}),
                ...(update.sidebarSortOrder !== undefined
                  ? { sidebarSortOrder: update.sidebarSortOrder }
                  : {}),
                updatedAt: event.payload.updatedAt,
              }
            : thread;
        }),
      });
    }

    case "folder.created":
      return decodeForEvent(FolderCreatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const existing = nextBase.folders.find((entry) => entry.id === payload.folderId);
          const nextProject = {
            id: payload.folderId,
            title: payload.title,
            workspaceRoot: payload.workspaceRoot,
            defaultModelSelection: payload.defaultModelSelection,
            scripts: payload.scripts,
            iconDataUrl: payload.iconDataUrl ?? null,
            isPinned: payload.isPinned ?? false,
            spaceId: payload.spaceId,
            sidebarSortOrder: payload.sidebarSortOrder ?? 0,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
            archivedAt: null,
            deletedAt: null,
          };

          return {
            ...nextBase,
            folders: existing
              ? nextBase.folders.map((entry) =>
                  entry.id === payload.folderId ? nextProject : entry,
                )
              : [...nextBase.folders, nextProject],
          };
        }),
      );

    case "folder.updated":
      return decodeForEvent(FolderUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          folders: nextBase.folders.map((folder) =>
            folder.id === payload.folderId
              ? {
                  ...folder,
                  ...(payload.title !== undefined ? { title: payload.title } : {}),
                  ...(payload.workspaceRoot !== undefined
                    ? { workspaceRoot: payload.workspaceRoot }
                    : {}),
                  ...(payload.defaultModelSelection !== undefined
                    ? { defaultModelSelection: payload.defaultModelSelection }
                    : {}),
                  ...(payload.scripts !== undefined ? { scripts: payload.scripts } : {}),
                  ...(payload.iconDataUrl !== undefined
                    ? { iconDataUrl: payload.iconDataUrl }
                    : {}),
                  ...(payload.isPinned !== undefined ? { isPinned: payload.isPinned } : {}),
                  ...(payload.sidebarSortOrder !== undefined
                    ? { sidebarSortOrder: payload.sidebarSortOrder }
                    : {}),
                  ...(payload.archivedAt !== undefined ? { archivedAt: payload.archivedAt } : {}),
                  updatedAt: payload.updatedAt,
                }
              : folder,
          ),
        })),
      );

    case "folder.moved":
      return decodeForEvent(FolderMovedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          folders: nextBase.folders.map((folder) =>
            folder.id === payload.folderId
              ? { ...folder, spaceId: payload.spaceId, updatedAt: payload.updatedAt }
              : folder,
          ),
        })),
      );

    case "folder.deleted":
      return decodeForEvent(FolderDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          folders: nextBase.folders.map((folder) =>
            folder.id === payload.folderId
              ? {
                  ...folder,
                  deletedAt: payload.deletedAt,
                  updatedAt: payload.deletedAt,
                }
              : folder,
          ),
        })),
      );

    case "thread.created":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadCreatedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread: OrchestrationThread = yield* decodeForEvent(
          OrchestrationThread,
          {
            id: payload.threadId,
            folderId: payload.folderId,
            sidebarSortOrder: payload.sidebarSortOrder ?? 0,
            title: payload.title,
            modelSelection: payload.modelSelection,
            runtimeMode: payload.runtimeMode,
            workingDirectory: payload.workingDirectory,
            isPinned: payload.isPinned,
            parentThreadId: payload.parentThreadId,
            creationSource: payload.creationSource ?? null,
            sourceThreadId: payload.sourceThreadId ?? null,
            sourceTurnId: payload.sourceTurnId ?? null,
            gatewayOperationId: payload.gatewayOperationId ?? null,
            gatewayOperationIndex: payload.gatewayOperationIndex ?? null,
            subagentAgentId: payload.subagentAgentId,
            subagentNickname: payload.subagentNickname,
            subagentRole: payload.subagentRole,
            forkSourceThreadId: payload.forkSourceThreadId,
            latestTurn: null,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
            archivedAt: null,
            deletedAt: null,
            messages: [],
            activities: [],
            session: null,
          },
          event.type,
          "thread",
        );
        const existing = nextBase.threads.find((entry) => entry.id === thread.id);
        return {
          ...nextBase,
          threads: existing
            ? nextBase.threads.map((entry) => (entry.id === thread.id ? thread : entry))
            : [...nextBase.threads, thread],
        };
      });

    case "thread.deleted":
      return decodeForEvent(ThreadDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            deletedAt: payload.deletedAt,
            updatedAt: payload.deletedAt,
          }),
        })),
      );

    case "thread.archived":
      return decodeForEvent(ThreadArchivedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const archivedAt = payload.archivedAt ?? payload.updatedAt ?? event.occurredAt;
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              archivedAt,
              updatedAt: payload.updatedAt ?? archivedAt,
            }),
          };
        }),
      );

    case "thread.unarchived":
      return decodeForEvent(ThreadUnarchivedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const updatedAt = payload.updatedAt ?? payload.unarchivedAt ?? event.occurredAt;
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              archivedAt: null,
              updatedAt,
            }),
          };
        }),
      );

    case "thread.updated":
      return decodeForEvent(ThreadUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              ...(payload.title !== undefined ? { title: payload.title } : {}),
              ...(payload.modelSelection !== undefined
                ? { modelSelection: payload.modelSelection }
                : {}),
              ...(payload.workingDirectory !== undefined
                ? { workingDirectory: payload.workingDirectory }
                : {}),
              ...(payload.isPinned !== undefined ? { isPinned: payload.isPinned } : {}),
              ...(payload.sidebarSortOrder !== undefined
                ? { sidebarSortOrder: payload.sidebarSortOrder }
                : {}),
              ...(payload.parentThreadId !== undefined
                ? { parentThreadId: payload.parentThreadId }
                : {}),
              ...(payload.subagentAgentId !== undefined
                ? { subagentAgentId: payload.subagentAgentId }
                : {}),
              ...(payload.subagentNickname !== undefined
                ? { subagentNickname: payload.subagentNickname }
                : {}),
              ...(payload.subagentRole !== undefined ? { subagentRole: payload.subagentRole } : {}),
              ...(payload.pinnedMessages !== undefined
                ? { pinnedMessages: payload.pinnedMessages }
                : {}),
              ...(payload.threadMarkers !== undefined
                ? { threadMarkers: payload.threadMarkers }
                : {}),
              ...(payload.notes !== undefined ? { notes: payload.notes } : {}),
              ...(payload.lastVisitedAt !== undefined
                ? { lastVisitedAt: payload.lastVisitedAt }
                : {}),
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "thread.pinned-message-added":
      return decodeForEvent(
        ThreadPinnedMessageAddedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const existingThread =
            nextBase.threads.find((thread) => thread.id === payload.threadId) ?? null;
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              pinnedMessages: addPinnedMessage(existingThread?.pinnedMessages, payload.pin),
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "thread.pinned-message-removed":
      return decodeForEvent(
        ThreadPinnedMessageRemovedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const existingThread =
            nextBase.threads.find((thread) => thread.id === payload.threadId) ?? null;
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              pinnedMessages: removePinnedMessage(
                existingThread?.pinnedMessages,
                payload.messageId,
              ),
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "thread.pinned-message-done-set":
      return decodeForEvent(
        ThreadPinnedMessageDoneSetPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const existingThread =
            nextBase.threads.find((thread) => thread.id === payload.threadId) ?? null;
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              pinnedMessages: setPinnedMessageDone(
                existingThread?.pinnedMessages,
                payload.messageId,
                payload.done,
              ),
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "thread.pinned-message-label-set":
      return decodeForEvent(
        ThreadPinnedMessageLabelSetPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const existingThread =
            nextBase.threads.find((thread) => thread.id === payload.threadId) ?? null;
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              pinnedMessages: setPinnedMessageLabel(
                existingThread?.pinnedMessages,
                payload.messageId,
                payload.label,
              ),
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "thread.marker-added":
      return decodeForEvent(ThreadMarkerAddedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const existingThread =
            nextBase.threads.find((thread) => thread.id === payload.threadId) ?? null;
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              threadMarkers: addThreadMarker(existingThread?.threadMarkers, payload.marker),
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "thread.marker-removed":
      return decodeForEvent(ThreadMarkerRemovedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const existingThread =
            nextBase.threads.find((thread) => thread.id === payload.threadId) ?? null;
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              threadMarkers: removeThreadMarker(existingThread?.threadMarkers, payload.markerId),
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "thread.marker-done-set":
      return decodeForEvent(ThreadMarkerDoneSetPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const existingThread =
            nextBase.threads.find((thread) => thread.id === payload.threadId) ?? null;
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              threadMarkers: setThreadMarkerDone(
                existingThread?.threadMarkers,
                payload.markerId,
                payload.done,
                payload.updatedAt,
              ),
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "thread.marker-label-set":
      return decodeForEvent(ThreadMarkerLabelSetPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const existingThread =
            nextBase.threads.find((thread) => thread.id === payload.threadId) ?? null;
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              threadMarkers: setThreadMarkerLabel(
                existingThread?.threadMarkers,
                payload.markerId,
                payload.label,
                payload.updatedAt,
              ),
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "thread.runtime-mode-set":
      return decodeForEvent(ThreadRuntimeModeSetPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            runtimeMode: payload.runtimeMode,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.turn-start-requested":
      return decodeForEvent(
        ThreadTurnStartRequestedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }
          const canAdoptFirstTurnProvider =
            thread.latestTurn === null && thread.session === null && thread.messages.length <= 1;
          const projectedModelSelection = deriveTurnStartModelSelection({
            currentModelSelection: thread.modelSelection,
            requestedModelSelection: payload.modelSelection,
            canAdoptRequestedProvider: canAdoptFirstTurnProvider,
          });
          const modelSelectionPatch =
            projectedModelSelection !== thread.modelSelection
              ? { modelSelection: projectedModelSelection }
              : {};
          const turnStartSession = deriveTurnStartSession({
            threadId: thread.id,
            currentSession: thread.session,
            providerName: projectedModelSelection.provider,
            requestedRuntimeMode: payload.runtimeMode,
            requestedAt: payload.createdAt,
          });
          const messages = thread.messages.map((message) =>
            message.id === payload.messageId && message.delivery !== undefined
              ? {
                  ...message,
                  delivery: {
                    ...message.delivery,
                    state:
                      payload.dispatchMode === "steer"
                        ? ("steering" as const)
                        : ("starting" as const),
                    sequence: event.sequence,
                  },
                }
              : message,
          );
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              ...modelSelectionPatch,
              ...(turnStartSession !== null ? { session: turnStartSession } : {}),
              messages,
              pendingTurnStartMessageId: payload.messageId,
              runtimeMode: payload.runtimeMode,
              updatedAt: payload.createdAt,
            }),
          };
        }),
      );

    case "thread.turn-steer-queued-requested": {
      const thread = nextBase.threads.find((entry) => entry.id === event.payload.threadId);
      if (!thread) return Effect.succeed(nextBase);
      return Effect.succeed({
        ...nextBase,
        threads: updateThread(nextBase.threads, event.payload.threadId, {
          messages: thread.messages.map((message) =>
            message.id === event.payload.messageId && message.delivery !== undefined
              ? {
                  ...message,
                  delivery: { ...message.delivery, state: "steering", sequence: event.sequence },
                }
              : message,
          ),
          updatedAt: event.payload.createdAt,
        }),
      });
    }

    case "thread.message-sent":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          MessageSentPayloadSchema,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const message: OrchestrationMessage = yield* decodeForEvent(
          OrchestrationMessage,
          {
            id: payload.messageId,
            role: payload.role,
            text: payload.text,
            ...(payload.attachments !== undefined ? { attachments: payload.attachments } : {}),
            ...(payload.skills !== undefined ? { skills: payload.skills } : {}),
            ...(payload.mentions !== undefined ? { mentions: payload.mentions } : {}),
            ...(payload.dispatchMode !== undefined ? { dispatchMode: payload.dispatchMode } : {}),
            ...(payload.dispatchOrigin !== undefined
              ? { dispatchOrigin: payload.dispatchOrigin }
              : {}),
            ...(payload.delivery !== undefined
              ? { delivery: { ...payload.delivery, sequence: event.sequence } }
              : {}),
            turnId: payload.turnId,
            streaming: payload.streaming,
            source: payload.source,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
          },
          event.type,
          "message",
        );

        // Hot path: one streamed delta must not cost a full copy-and-rebuild of
        // the transcript. Update the one affected slot in a single shallow copy
        // and only re-cap when the transcript actually grew past the limit.
        const existingIndex = findMessageIndexFromEnd(thread.messages, message.id);
        let cappedMessages: ReadonlyArray<OrchestrationMessage>;
        if (existingIndex >= 0) {
          const entry = thread.messages[existingIndex]!;
          const nextMessages = thread.messages.slice();
          nextMessages[existingIndex] = {
            ...entry,
            text: message.streaming
              ? `${entry.text}${message.text}`
              : message.text.length > 0
                ? message.text
                : entry.text,
            streaming: message.streaming,
            source: message.source,
            updatedAt: message.updatedAt,
            turnId: resolveStableMessageTurnId({
              existingTurnId: entry.turnId,
              incomingTurnId: message.turnId,
            }),
            ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
            ...(message.skills !== undefined ? { skills: message.skills } : {}),
            ...(message.mentions !== undefined ? { mentions: message.mentions } : {}),
            ...(message.dispatchMode !== undefined ? { dispatchMode: message.dispatchMode } : {}),
            ...(message.dispatchOrigin !== undefined
              ? { dispatchOrigin: message.dispatchOrigin }
              : {}),
            ...(message.delivery !== undefined &&
            (entry.delivery === undefined || message.delivery.sequence >= entry.delivery.sequence)
              ? { delivery: message.delivery }
              : {}),
          };
          cappedMessages = nextMessages;
        } else {
          cappedMessages =
            thread.messages.length >= MAX_THREAD_MESSAGES
              ? [
                  ...thread.messages.slice(thread.messages.length - MAX_THREAD_MESSAGES + 1),
                  message,
                ]
              : [...thread.messages, message];
        }

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            messages: cappedMessages,
            ...(payload.role === "user" && payload.delivery?.state === "starting"
              ? { pendingTurnStartMessageId: payload.messageId }
              : {}),
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.message-delivery-set":
      return decodeForEvent(
        ThreadMessageDeliverySetPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) return nextBase;
          const messages = thread.messages.map((message) =>
            message.id === payload.messageId && message.delivery !== undefined
              ? {
                  ...message,
                  delivery: {
                    ...message.delivery,
                    state: payload.state,
                    sequence: event.sequence,
                  },
                  updatedAt: payload.updatedAt,
                }
              : message,
          );
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              messages,
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "thread.session-set":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadSessionSetPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const session: OrchestrationSession = yield* decodeForEvent(
          OrchestrationSession,
          payload.session,
          event.type,
          "session",
        );

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            session,
            pendingTurnStartMessageId:
              session.status === "starting"
                ? (thread.pendingTurnStartMessageId ??
                  thread.messages.findLast(
                    (message) => message.role === "user" && message.delivery?.state === "starting",
                  )?.id ??
                  null)
                : null,
            latestTurn:
              session.status === "running" && session.activeTurnId !== null
                ? thread.latestTurn?.turnId === session.activeTurnId &&
                  isTerminalLatestTurn(thread.latestTurn)
                  ? thread.latestTurn
                  : {
                      turnId: session.activeTurnId,
                      state: "running",
                      requestedAt:
                        thread.latestTurn?.turnId === session.activeTurnId
                          ? thread.latestTurn.requestedAt
                          : session.updatedAt,
                      startedAt:
                        thread.latestTurn?.turnId === session.activeTurnId
                          ? (thread.latestTurn.startedAt ?? session.updatedAt)
                          : session.updatedAt,
                      completedAt: null,
                      assistantMessageId:
                        thread.latestTurn?.turnId === session.activeTurnId
                          ? thread.latestTurn.assistantMessageId
                          : null,
                    }
                : settleLatestTurnForSessionStatus(thread.latestTurn, session),
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.turn-start-cancelled":
      return decodeForEvent(
        ThreadTurnStartCancelledPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }
          const messages = thread.messages.filter((message) => message.id !== payload.messageId);
          if (messages.length === thread.messages.length) {
            return nextBase;
          }
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              messages,
              pendingTurnStartMessageId: null,
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    case "thread.conversation-rolled-back":
      return decodeForEvent(
        ThreadConversationRolledBackPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          if (payload.numTurns === 0) {
            return nextBase;
          }
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }

          const rollback = rollbackThreadMessagesFromMessage(
            thread.messages,
            payload.messageId,
            payload.skipAttachmentPrune === true,
          );
          if (rollback.messages === thread.messages) {
            return nextBase;
          }

          const activities = thread.activities.filter(
            (activity) => activity.turnId === null || !rollback.removedTurnIds.has(activity.turnId),
          );

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              messages: rollback.messages.slice(-MAX_THREAD_MESSAGES),
              activities,
              latestTurn: null,
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    case "thread.activity-appended":
      return decodeForEvent(
        ThreadActivityAppendedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }

          const activities = upsertThreadActivity(thread.activities, {
            ...payload.activity,
            sequence: event.sequence,
          });

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              activities,
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    default:
      return Effect.succeed(nextBase);
  }
}
