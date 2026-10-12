import type {
  MessageDelivery,
  OrchestrationEvent,
  OrchestrationReadModel,
  ThreadId,
} from "@penkra/contracts";
import {
  ORCHESTRATION_THREAD_HYDRATION_LIMITS,
  OrchestrationMessage,
  OrchestrationSession,
  OrchestrationThread,
  ThreadMessageDeliverySetPayload,
} from "@penkra/contracts";
import { providerSupportsNativeTurnSteering } from "@penkra/shared/providerMetadata";
import { shouldInterruptProvisionalCompletion } from "@penkra/shared/turnContinuation";
import { Effect, Schema } from "effect";

import { OrchestrationProjectorDecodeError, toProjectorDecodeError } from "./Errors.ts";
import {
  MessageSentPayloadSchema,
  ThreadActivityAppendedPayload,
  ThreadConversationRolledBackPayload,
  ThreadSessionSetPayload,
  ThreadTurnStartRequestedPayload,
  ThreadTurnStartCancelledPayload,
} from "./Schemas.ts";

function withoutDeliveryFailureEvidence(delivery: MessageDelivery): MessageDelivery {
  const { failurePhase: _failurePhase, failureDetail: _failureDetail, ...current } = delivery;
  return current;
}
import { resolveStableMessageTurnId } from "./messageTurnId.ts";
import { settleTurnStateFromSession } from "./turnLifecycle.ts";
import { deriveTurnStartSession } from "./turnStartSession.ts";

type ThreadPatch = Partial<Omit<OrchestrationThread, "id" | "folderId">>;
const MAX_THREAD_MESSAGES = ORCHESTRATION_THREAD_HYDRATION_LIMITS.messages;
const MAX_THREAD_ACTIVITIES = ORCHESTRATION_THREAD_HYDRATION_LIMITS.summaryActivities;

function isTerminalLatestTurn(
  latestTurn: OrchestrationThread["latestTurn"] | null | undefined,
): boolean {
  if (!latestTurn?.completedAt) {
    return false;
  }
  return (
    latestTurn.state === "completed" ||
    latestTurn.state === "error" ||
    latestTurn.state === "interrupted" ||
    latestTurn.state === "cancelled"
  );
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
  previousSession: OrchestrationThread["session"],
): OrchestrationThread["latestTurn"] {
  if (
    shouldInterruptProvisionalCompletion({
      previousSession,
      nextSession: session,
      turn: latestTurn,
    }) &&
    latestTurn
  ) {
    return { ...latestTurn, state: "interrupted", completedAt: session.updatedAt };
  }
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
    case "thread.marker-added":
    case "thread.marker-removed":
    case "thread.marker-done-set":
    case "thread.marker-label-set":
      return Effect.succeed(nextBase);

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
          const turnStartSession = deriveTurnStartSession({
            threadId: thread.id,
            currentSession: thread.session,
            providerName: thread.modelSelection.provider,
            requestedAt: payload.createdAt,
          });
          const messages = thread.messages.map((message) =>
            message.id === payload.messageId && message.delivery !== undefined
              ? {
                  ...message,
                  delivery: {
                    ...withoutDeliveryFailureEvidence(message.delivery),
                    state:
                      payload.dispatchMode === "steer"
                        ? ("steering" as const)
                        : ("starting" as const),
                    sequence: event.sequence,
                  },
                }
              : message,
          );
          const nativeSteer =
            payload.dispatchMode === "steer" &&
            providerSupportsNativeTurnSteering(
              thread.session?.providerName ?? thread.modelSelection.provider,
            );
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              ...(turnStartSession !== null ? { session: turnStartSession } : {}),
              messages,
              pendingTurnStartMessageId:
                // A native steer rides an existing provider turn. Providers
                // without live steering start replacement work after interrupt.
                nativeSteer ? thread.pendingTurnStartMessageId : payload.messageId,
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
                  dispatchMode: "steer",
                  delivery: {
                    ...message.delivery,
                    state: "steering",
                    sequence: event.sequence,
                  },
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
            ...(payload.dispatchOrigin === "agent" && payload.senderThreadId !== undefined
              ? { senderThreadId: payload.senderThreadId }
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
          const effectiveDispatchOrigin = message.dispatchOrigin ?? entry.dispatchOrigin;
          const entryForMerge =
            effectiveDispatchOrigin !== "agent"
              ? (({ senderThreadId: _senderThreadId, ...rest }) => rest)(entry)
              : entry;
          nextMessages[existingIndex] = {
            ...entryForMerge,
            text: message.streaming
              ? `${entry.text}${message.text}`
              : message.text.length > 0
                ? message.text
                : entry.text,
            streaming: message.streaming,
            source: message.source,
            // Reusing a user message id is the edit-and-resend contract: the
            // replacement is dispatched at a new causal boundary. Preserve
            // assistant stream creation times across deltas, but move the
            // edited user message to the replay boundary so live/snapshot
            // projections agree with projection_thread_messages and elapsed
            // work is not measured from the superseded send.
            createdAt: message.role === "user" ? message.createdAt : entry.createdAt,
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
            ...(message.senderThreadId !== undefined
              ? { senderThreadId: message.senderThreadId }
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
          const targetDeliveryState = thread.messages.find(
            (message) => message.id === payload.messageId,
          )?.delivery?.state;
          const nativeSteer = providerSupportsNativeTurnSteering(
            thread.session?.providerName ?? thread.modelSelection.provider,
          );
          const isUnacceptedAttempt =
            targetDeliveryState === "starting" || targetDeliveryState === "steering";
          const isUndeliveredAttempt = isUnacceptedAttempt || targetDeliveryState === "queued";
          const acceptsSteerOwner =
            payload.state === "accepted" &&
            nativeSteer &&
            targetDeliveryState === "steering" &&
            thread.pendingTurnStartMessageId === payload.messageId;
          // Replays can begin from a read model written by an older projector;
          // acceptance retires any steer that was incorrectly made the owner.
          const clearsPendingTurnStart =
            acceptsSteerOwner ||
            (payload.failurePhase === "before-provider-dispatch" &&
              isUnacceptedAttempt &&
              thread.pendingTurnStartMessageId === payload.messageId);
          const ownsStartingSession =
            payload.failurePhase === "before-provider-dispatch" &&
            isUnacceptedAttempt &&
            thread.pendingTurnStartMessageId === payload.messageId &&
            thread.session?.status === "starting" &&
            thread.session.activeTurnId === null;
          const messages = thread.messages.map((message) =>
            message.id === payload.messageId &&
            message.delivery !== undefined &&
            (payload.failurePhase !== "before-provider-dispatch" ||
              message.delivery.state === "starting" ||
              message.delivery.state === "steering" ||
              message.delivery.state === "queued")
              ? {
                  ...message,
                  delivery: {
                    ...withoutDeliveryFailureEvidence(message.delivery),
                    state: payload.state,
                    ...(payload.queued !== undefined ? { queued: payload.queued } : {}),
                    sequence: event.sequence,
                    ...(payload.failurePhase !== undefined
                      ? { failurePhase: payload.failurePhase }
                      : {}),
                    ...(payload.failureDetail !== undefined
                      ? { failureDetail: payload.failureDetail }
                      : {}),
                  },
                  updatedAt: payload.updatedAt,
                }
              : message,
          );
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              messages,
              ...(payload.failurePhase === "before-provider-dispatch" &&
              isUndeliveredAttempt &&
              payload.turnId !== undefined &&
              thread.latestTurn?.turnId === payload.turnId &&
              (thread.latestTurn.state === "running" || thread.latestTurn.state === "queued") &&
              thread.latestTurn.startedAt === null
                ? {
                    latestTurn: {
                      ...thread.latestTurn,
                      state: "error" as const,
                      completedAt: payload.updatedAt,
                    },
                  }
                : {}),
              ...(payload.state === "accepted" &&
              payload.terminalState !== undefined &&
              payload.terminalCompletedAt !== undefined &&
              payload.turnId !== undefined &&
              thread.latestTurn?.turnId === payload.turnId &&
              thread.latestTurn.state === "running"
                ? {
                    latestTurn: {
                      ...thread.latestTurn,
                      state: payload.terminalState,
                      completedAt: payload.terminalCompletedAt,
                    },
                  }
                : {}),
              pendingTurnStartMessageId: clearsPendingTurnStart
                ? null
                : thread.pendingTurnStartMessageId,
              ...(ownsStartingSession && payload.failureDetail !== undefined
                ? {
                    session: {
                      ...thread.session,
                      status: "error" as const,
                      lastError: payload.failureDetail,
                      updatedAt: payload.updatedAt,
                    },
                  }
                : {}),
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "thread.provider-lifecycle-write-skipped":
      return Effect.succeed(nextBase);

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
              session.status === "starting" || session.status === "ready"
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
                : settleLatestTurnForSessionStatus(thread.latestTurn, session, thread.session),
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
          const queuedMessageIds = thread.queuedMessageIds?.filter(
            (messageId) => messageId !== payload.messageId,
          );
          if (
            messages.length === thread.messages.length &&
            queuedMessageIds?.length === thread.queuedMessageIds?.length
          ) {
            return nextBase;
          }
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              messages,
              queuedMessageIds,
              pendingTurnStartMessageId:
                thread.pendingTurnStartMessageId === payload.messageId
                  ? null
                  : thread.pendingTurnStartMessageId,
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
