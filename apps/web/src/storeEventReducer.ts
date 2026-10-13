// FILE: storeEventReducer.ts
// Purpose: Reduces ordered orchestration domain events into normalized client state.
// Exports: Normal and hot-path event batch reducers.

import {
  type OrchestrationEvent,
  type OrchestrationPendingInteraction,
  type ThreadId,
} from "@penkra/contracts";

import { isSessionRunningTurn, latestTurnMatchesTurnId } from "./session-logic";
import { shouldInterruptProvisionalCompletion } from "@penkra/shared/turnContinuation";
import {
  MAX_THREAD_MESSAGES,
  asActivityRecord,
  createThreadActivityAccumulator,
  compareChatMessagesForTranscript,
  latestDeliveryFailureReason,
  normalizeActivities,
  normalizeChatMessage,
  normalizeModelSelection,
  normalizeThreadErrorMessage,
  normalizeThreadSession,
  providerReferenceArraysEqual,
  withOrchestrationEventSequence,
} from "./storeNormalization";
import { applyThreadUpdate } from "./storeProjection";
import type { AppState } from "./storeState";
import type { ChatMessage, Thread } from "./types";

type ThreadMessageSentEvent = Extract<OrchestrationEvent, { type: "thread.message-sent" }>;
type ThreadActivityAppendedEvent = Extract<
  OrchestrationEvent,
  { type: "thread.activity-appended" }
>;
export type ApplyOrchestrationEventOptions = {
  updateSidebarSummary?: boolean;
};

type ReadModelThread = import("@penkra/contracts").OrchestrationReadModel["threads"][number];

const THREAD_SUMMARY_ACTIVITY_KINDS = new Set([
  "user-input.requested",
  "user-input.resolved",
  "provider.user-input.respond.failed",
]);

function resolveEventUpdatedAt(thread: Thread, updatedAt: string): string {
  const currentUpdatedAt = thread.updatedAt ?? thread.createdAt;
  return currentUpdatedAt > updatedAt ? currentUpdatedAt : updatedAt;
}

function threadMessageUpdatesSummary(event: ThreadMessageSentEvent): boolean {
  return event.payload.role === "user";
}

function threadActivityUpdatesSummary(event: ThreadActivityAppendedEvent): boolean {
  return THREAD_SUMMARY_ACTIVITY_KINDS.has(event.payload.activity.kind);
}

function threadMessageUpdatesSidebarSummary(event: ThreadMessageSentEvent): boolean {
  return event.payload.role === "user" || !event.payload.streaming;
}

/** Pure reconciliation over the pending-interaction list alone: batch callers thread the
 *  accumulated list through directly instead of cloning the whole `Thread` per event. */
function reconcilePendingInteractionsFromActivity(
  threadId: ThreadId,
  pendingInteractions: Thread["pendingInteractions"],
  event: ThreadActivityAppendedEvent,
): Thread["pendingInteractions"] {
  const activity = event.payload.activity;
  const interactionKind =
    activity.kind === "user-input.requested" ||
    activity.kind === "user-input.resolved" ||
    activity.kind === "provider.user-input.respond.failed"
      ? ("userInput" as const)
      : null;
  if (interactionKind === null) {
    return pendingInteractions;
  }
  const payload = asActivityRecord(activity.payload);
  const requestId = payload?.requestId;
  if (typeof requestId !== "string" || requestId.length === 0) {
    return pendingInteractions;
  }
  const lifecycleGeneration =
    typeof payload?.lifecycleGeneration === "string" && payload.lifecycleGeneration.length > 0
      ? payload.lifecycleGeneration
      : null;
  const existing = pendingInteractions ?? [];
  const matchesIdentity = (interaction: OrchestrationPendingInteraction) =>
    interaction.interactionKind === interactionKind &&
    interaction.requestId === requestId &&
    (lifecycleGeneration === null || interaction.lifecycleGeneration === lifecycleGeneration);

  if (activity.kind === "user-input.resolved") {
    const next = existing.filter((interaction) => !matchesIdentity(interaction));
    return next.length === existing.length ? pendingInteractions : next;
  }

  if (activity.kind === "provider.user-input.respond.failed") {
    const responseCommandId = payload?.responseCommandId;
    if (typeof responseCommandId !== "string" || responseCommandId.length === 0) {
      return pendingInteractions;
    }
    const settlementStatus: OrchestrationPendingInteraction["status"] =
      payload?.settlementStatus === "retryable" ? "retryable" : "uncertain";
    let changed = false;
    const next = existing.map((interaction) => {
      if (
        !matchesIdentity(interaction) ||
        interaction.status !== "responding" ||
        interaction.responseCommandId !== responseCommandId
      ) {
        return interaction;
      }
      changed = true;
      return { ...interaction, status: settlementStatus, resolvedAt: null };
    });
    return changed ? next : pendingInteractions;
  }

  const exactIndex = existing.findIndex(
    (interaction) =>
      interaction.interactionKind === interactionKind && interaction.requestId === requestId,
  );
  const current = exactIndex >= 0 ? existing[exactIndex] : undefined;
  if (
    current &&
    current.lifecycleGeneration === lifecycleGeneration &&
    (current.status === "responding" ||
      current.status === "confirmed" ||
      current.status === "uncertain")
  ) {
    return pendingInteractions;
  }
  const pending: OrchestrationPendingInteraction = {
    interactionKind,
    requestId: requestId as OrchestrationPendingInteraction["requestId"],
    threadId,
    turnId: activity.turnId,
    lifecycleGeneration,
    status: "pending",
    responseCommandId: null,
    responseRequestedAt: null,
    createdAt:
      current?.lifecycleGeneration === lifecycleGeneration ? current.createdAt : activity.createdAt,
    resolvedAt: null,
  };
  if (exactIndex < 0) {
    return [...existing, pending];
  }
  const next = [...existing];
  next[exactIndex] = pending;
  return next;
}

function buildLatestTurn(params: {
  previous: Thread["latestTurn"];
  turnId: NonNullable<Thread["latestTurn"]>["turnId"];
  providerTurnId?: NonNullable<Thread["latestTurn"]>["turnId"];
  state: NonNullable<Thread["latestTurn"]>["state"];
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  assistantMessageId: NonNullable<Thread["latestTurn"]>["assistantMessageId"];
}): NonNullable<Thread["latestTurn"]> {
  const providerTurnId =
    params.providerTurnId ??
    (params.previous?.turnId === params.turnId ? params.previous.providerTurnId : undefined);
  return {
    turnId: params.turnId,
    ...(providerTurnId !== undefined ? { providerTurnId } : {}),
    state: params.state,
    requestedAt: params.requestedAt,
    startedAt: params.startedAt,
    completedAt: params.completedAt,
    assistantMessageId: params.assistantMessageId,
  };
}

function reconcileLatestTurnFromSession(
  thread: Thread,
  session: NonNullable<ReadModelThread["session"]>,
  error: string | null,
): Thread["latestTurn"] {
  if (
    shouldInterruptProvisionalCompletion({
      previousSession: thread.session,
      nextSession: session,
      turn: thread.latestTurn,
    }) &&
    thread.latestTurn
  ) {
    return buildLatestTurn({
      previous: thread.latestTurn,
      turnId: thread.latestTurn.turnId,
      state: "interrupted",
      requestedAt: thread.latestTurn.requestedAt,
      startedAt: thread.latestTurn.startedAt,
      completedAt: session.updatedAt,
      assistantMessageId: thread.latestTurn.assistantMessageId,
    });
  }
  if (isSessionRunningTurn(session)) {
    const matchedLatestTurn = latestTurnMatchesTurnId(thread.latestTurn, session.activeTurnId)
      ? thread.latestTurn
      : null;
    // A provider turn has its own ID. The pending user message retains the
    // logical turn ID from thread.turn-start-requested until this session starts.
    const pendingMessage = thread.messages.find(
      (message) => message.id === thread.pendingTurnStartMessageId && message.role === "user",
    );
    const logicalTurnId =
      matchedLatestTurn?.turnId ?? pendingMessage?.turnId ?? session.activeTurnId;
    return buildLatestTurn({
      previous: thread.latestTurn,
      turnId: logicalTurnId,
      ...(logicalTurnId !== session.activeTurnId ? { providerTurnId: session.activeTurnId } : {}),
      state: "running",
      requestedAt: matchedLatestTurn?.requestedAt ?? pendingMessage?.createdAt ?? session.updatedAt,
      startedAt:
        matchedLatestTurn !== null
          ? (matchedLatestTurn.startedAt ?? session.updatedAt)
          : session.updatedAt,
      completedAt: null,
      assistantMessageId: matchedLatestTurn?.assistantMessageId ?? null,
    });
  }

  // Mirror of the server projector's settlement rule: once the session leaves
  // "running", no later event is guaranteed to close the turn, so a still-running
  // latestTurn settles here. A retained
  // activeTurnId blocks settlement (except on error): stop-requested flows emit
  // "interrupted" while keeping the turn active until the provider's terminal
  // event decides the real outcome.
  const settledState =
    session.status === "error"
      ? ("error" as const)
      : session.status === "interrupted" || session.status === "stopped"
        ? ("interrupted" as const)
        : session.status === "ready"
          ? ("completed" as const)
          : null;
  if (
    settledState !== null &&
    thread.latestTurn !== null &&
    ((thread.latestTurn.state === "running" &&
      (session.activeTurnId == null || settledState === "error")) ||
      (settledState === "error" &&
        thread.latestTurn.state === "completed" &&
        isSessionRunningTurn(thread.session) &&
        latestTurnMatchesTurnId(thread.latestTurn, thread.session.activeTurnId)))
  ) {
    return buildLatestTurn({
      previous: thread.latestTurn,
      turnId: thread.latestTurn.turnId,
      state: settledState,
      requestedAt: thread.latestTurn.requestedAt,
      startedAt: thread.latestTurn.startedAt,
      completedAt: session.updatedAt,
      assistantMessageId: thread.latestTurn.assistantMessageId,
    });
  }

  void error;
  return thread.latestTurn;
}

function rollbackThreadMessagesFromMessage(
  messages: ReadonlyArray<ChatMessage>,
  messageId: string,
): {
  readonly messages: ChatMessage[];
  readonly removedTurnIds: ReadonlySet<string>;
} {
  const targetIndex = messages.findIndex((message) => message.id === messageId);
  if (targetIndex < 0) {
    return { messages: [...messages], removedTurnIds: new Set() };
  }

  const removedMessages = messages.slice(targetIndex);
  return {
    messages: messages.slice(0, targetIndex),
    removedTurnIds: new Set(
      removedMessages.flatMap((message) =>
        message.turnId === undefined || message.turnId === null ? [] : [message.turnId],
      ),
    ),
  };
}

function mergeStreamingMessage(
  existingMessage: ChatMessage,
  incomingMessage: ChatMessage,
): ChatMessage | null {
  let nextText: string;
  if (
    existingMessage.role === "user" &&
    incomingMessage.role === "user" &&
    !incomingMessage.streaming
  ) {
    nextText = incomingMessage.text;
  } else if (incomingMessage.streaming || incomingMessage.text.length === 0) {
    nextText = `${existingMessage.text}${incomingMessage.text}`;
  } else if (incomingMessage.text.startsWith(existingMessage.text)) {
    nextText = incomingMessage.text;
  } else if (existingMessage.text.startsWith(incomingMessage.text)) {
    nextText = existingMessage.text;
  } else {
    nextText = `${existingMessage.text}${incomingMessage.text}`;
  }
  const nextAttachments = incomingMessage.attachments ?? existingMessage.attachments;
  const nextSkills =
    incomingMessage.skills && incomingMessage.skills.length > 0
      ? incomingMessage.skills
      : existingMessage.skills;
  const nextMentions =
    incomingMessage.mentions && incomingMessage.mentions.length > 0
      ? incomingMessage.mentions
      : existingMessage.mentions;
  const nextCompletedAt = incomingMessage.streaming
    ? existingMessage.completedAt
    : (incomingMessage.completedAt ?? existingMessage.completedAt);
  const nextTurnId =
    incomingMessage.turnId !== undefined ? incomingMessage.turnId : existingMessage.turnId;
  const nextDispatchMode =
    incomingMessage.dispatchMode !== undefined
      ? incomingMessage.dispatchMode
      : existingMessage.dispatchMode;
  const nextDispatchOrigin =
    incomingMessage.dispatchOrigin !== undefined
      ? incomingMessage.dispatchOrigin
      : existingMessage.dispatchOrigin;
  const nextSenderThreadId =
    nextDispatchOrigin === "agent"
      ? (incomingMessage.senderThreadId ?? existingMessage.senderThreadId)
      : undefined;
  const nextDelivery =
    incomingMessage.delivery === undefined ||
    (existingMessage.delivery !== undefined &&
      existingMessage.delivery.sequence > incomingMessage.delivery.sequence)
      ? existingMessage.delivery
      : incomingMessage.delivery;
  const nextSource = incomingMessage.source ?? existingMessage.source;

  if (
    existingMessage.text === nextText &&
    existingMessage.streaming === incomingMessage.streaming &&
    existingMessage.attachments === nextAttachments &&
    providerReferenceArraysEqual(existingMessage.skills, nextSkills) &&
    providerReferenceArraysEqual(existingMessage.mentions, nextMentions) &&
    existingMessage.completedAt === nextCompletedAt &&
    existingMessage.turnId === nextTurnId &&
    existingMessage.dispatchMode === nextDispatchMode &&
    existingMessage.dispatchOrigin === nextDispatchOrigin &&
    existingMessage.senderThreadId === nextSenderThreadId &&
    existingMessage.delivery === nextDelivery &&
    existingMessage.source === nextSource
  ) {
    return null;
  }

  const existingMessageForMerge =
    nextDispatchOrigin !== "agent"
      ? (({ senderThreadId: _senderThreadId, ...message }) => message)(existingMessage)
      : existingMessage;
  return {
    ...existingMessageForMerge,
    text: nextText,
    streaming: incomingMessage.streaming,
    ...(nextAttachments ? { attachments: nextAttachments } : {}),
    ...(nextSkills && nextSkills.length > 0 ? { skills: [...nextSkills] } : {}),
    ...(nextMentions && nextMentions.length > 0 ? { mentions: [...nextMentions] } : {}),
    ...(nextTurnId !== undefined ? { turnId: nextTurnId } : {}),
    ...(nextDispatchMode !== undefined ? { dispatchMode: nextDispatchMode } : {}),
    ...(nextDispatchOrigin !== undefined ? { dispatchOrigin: nextDispatchOrigin } : {}),
    ...(nextSenderThreadId !== undefined ? { senderThreadId: nextSenderThreadId } : {}),
    ...(nextDelivery !== undefined ? { delivery: nextDelivery } : {}),
    ...(nextSource !== undefined ? { source: nextSource } : {}),
    ...(nextCompletedAt !== undefined ? { completedAt: nextCompletedAt } : {}),
  };
}

function applyThreadMessageSentEvent(
  thread: Thread,
  event: ThreadMessageSentEvent,
  options: { readonly capMessages: boolean },
): Thread {
  const payload = event.payload;
  // Single scan: the previous implementation ran `find` and `findIndex` with the same predicate
  // over the (up to MAX_THREAD_MESSAGES) message list for every streaming delta.
  const existingIndex = thread.messages.findIndex((message) => message.id === payload.messageId);
  const existingMessage = existingIndex >= 0 ? thread.messages[existingIndex] : undefined;
  const incomingMessage = normalizeChatMessage(
    {
      id: payload.messageId,
      role: payload.role,
      text: payload.text,
      dispatchMode: payload.dispatchMode,
      dispatchOrigin: payload.dispatchOrigin,
      senderThreadId: payload.senderThreadId,
      ...(payload.delivery !== undefined
        ? { delivery: { ...payload.delivery, sequence: event.sequence } }
        : {}),
      sequence: event.sequence,
      turnId: payload.turnId,
      attachments: payload.attachments ?? [],
      ...(payload.skills !== undefined ? { skills: payload.skills } : {}),
      ...(payload.mentions !== undefined ? { mentions: payload.mentions } : {}),
      streaming: payload.streaming,
      source: payload.source,
      createdAt: payload.createdAt,
      updatedAt: payload.updatedAt,
    },
    existingMessage,
  );
  let messages = thread.messages;

  if (existingMessage) {
    const mergedMessage = mergeStreamingMessage(existingMessage, incomingMessage);
    if (mergedMessage !== null) {
      // Only the affected slot is replaced; every other message stays reference-identical.
      messages = thread.messages.with(existingIndex, mergedMessage);
    }
  } else {
    const appendedMessages = [...thread.messages, incomingMessage];
    messages = options.capMessages
      ? appendedMessages.slice(-MAX_THREAD_MESSAGES)
      : appendedMessages;
  }

  let latestTurn = thread.latestTurn;
  if (
    payload.role === "assistant" &&
    payload.turnId !== null &&
    (thread.latestTurn === null || latestTurnMatchesTurnId(thread.latestTurn, payload.turnId))
  ) {
    const previousTurn = thread.latestTurn;
    latestTurn = buildLatestTurn({
      previous: previousTurn,
      turnId: previousTurn?.turnId ?? payload.turnId,
      state: payload.streaming
        ? "running"
        : previousTurn?.state === "interrupted"
          ? "interrupted"
          : previousTurn?.state === "error"
            ? "error"
            : "completed",
      requestedAt: previousTurn?.requestedAt ?? payload.createdAt,
      startedAt: previousTurn?.startedAt ?? payload.createdAt,
      completedAt: payload.streaming ? (previousTurn?.completedAt ?? null) : payload.updatedAt,
      assistantMessageId: payload.messageId,
    });
  }

  const updatedAt =
    thread.updatedAt && thread.updatedAt > payload.updatedAt ? thread.updatedAt : payload.updatedAt;
  if (
    messages === thread.messages &&
    latestTurn === thread.latestTurn &&
    updatedAt === thread.updatedAt
  ) {
    return thread;
  }

  return {
    ...thread,
    messages,
    latestTurn,
    updatedAt,
  };
}

function applyOrchestrationEvent(
  state: AppState,
  event: OrchestrationEvent,
  options?: ApplyOrchestrationEventOptions,
): AppState {
  switch (event.type) {
    // Historical marker events remain decodable but no longer affect UI state.
    case "thread.marker-added":
    case "thread.marker-removed":
    case "thread.marker-done-set":
    case "thread.marker-label-set":
      return state;

    case "thread.message-sent":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) =>
          applyThreadMessageSentEvent(thread, event, {
            capMessages: state.threadDetailSyncById?.[event.payload.threadId] !== "synced",
          }),
        {
          ...options,
          recomputeSummarySignals: threadMessageUpdatesSummary(event),
          updateSidebarSummary:
            options?.updateSidebarSummary === true || threadMessageUpdatesSidebarSummary(event),
        },
      );

    case "thread.provider-lifecycle-write-skipped":
      return state;

    case "thread.session-set":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          const session = normalizeThreadSession(event.payload.session, thread.session);
          const sessionError = normalizeThreadErrorMessage(event.payload.session.lastError);
          const deliveryError = latestDeliveryFailureReason(thread.messages);
          const error = sessionError ?? deliveryError;
          const errorSource =
            sessionError === null && deliveryError !== null ? "delivery" : undefined;
          const latestTurn = reconcileLatestTurnFromSession(thread, event.payload.session, error);
          const pendingTurnStartMessageId =
            event.payload.session.status === "starting" || event.payload.session.status === "ready"
              ? (thread.pendingTurnStartMessageId ?? null)
              : null;
          if (
            session === thread.session &&
            error === thread.error &&
            errorSource === thread.errorSource &&
            latestTurn === thread.latestTurn &&
            pendingTurnStartMessageId === (thread.pendingTurnStartMessageId ?? null)
          ) {
            return thread;
          }
          return {
            ...thread,
            session,
            error,
            errorSource,
            latestTurn,
            pendingTurnStartMessageId,
            updatedAt:
              (thread.updatedAt ?? thread.createdAt) > event.occurredAt
                ? thread.updatedAt
                : event.occurredAt,
          };
        },
        {
          ...options,
          updateSidebarSummary: true,
        },
      );

    case "thread.turn-interrupt-requested": {
      // Interrupt requests are best-effort and can fail or time out. Keep the
      // latest-turn clock/state live until the provider confirms a terminal event.
      return state;
    }

    case "thread.turn-queued":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) =>
          (thread.queuedMessageIds ?? []).includes(event.payload.messageId)
            ? thread
            : {
                ...thread,
                queuedMessageIds: [...(thread.queuedMessageIds ?? []), event.payload.messageId],
              },
        { ...options, updateSidebarSummary: false },
      );

    case "thread.session-stop-requested":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          if (thread.session === null) {
            return thread;
          }
          const latestTurn =
            thread.latestTurn !== null &&
            thread.latestTurn.state === "running" &&
            thread.latestTurn.completedAt === null
              ? buildLatestTurn({
                  previous: thread.latestTurn,
                  turnId: thread.latestTurn.turnId,
                  state: "interrupted",
                  requestedAt: thread.latestTurn.requestedAt,
                  startedAt: thread.latestTurn.startedAt ?? event.payload.createdAt,
                  completedAt: event.payload.createdAt,
                  assistantMessageId: thread.latestTurn.assistantMessageId,
                })
              : thread.latestTurn;
          return {
            ...thread,
            session: {
              ...thread.session,
              status: "closed",
              orchestrationStatus: "stopped",
              activeTurnId: undefined,
              updatedAt: event.payload.createdAt,
            },
            latestTurn,
            updatedAt:
              (thread.updatedAt ?? thread.createdAt) > event.occurredAt
                ? thread.updatedAt
                : event.occurredAt,
          };
        },
        {
          ...options,
          updateSidebarSummary: true,
        },
      );

    case "thread.activity-read-model-updated":
      if (event.payload.activity === undefined) {
        return state;
      }
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          const sequencedActivity = withOrchestrationEventSequence(
            event.payload.activity!,
            event.sequence,
          );
          const nextActivities = normalizeActivities(
            [...thread.activities, sequencedActivity],
            thread.activities,
            { cap: state.threadDetailSyncById?.[event.payload.threadId] !== "synced" },
          );
          return nextActivities === thread.activities
            ? thread
            : {
                ...thread,
                activities: nextActivities,
                updatedAt:
                  (thread.updatedAt ?? thread.createdAt) > sequencedActivity.createdAt
                    ? thread.updatedAt
                    : sequencedActivity.createdAt,
              };
        },
        {
          capActivities: state.threadDetailSyncById?.[event.payload.threadId] !== "synced",
          ...options,
          updateSidebarSummary: true,
        },
      );

    case "thread.activity-appended":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          const sequencedActivity = withOrchestrationEventSequence(
            event.payload.activity,
            event.sequence,
          );
          const nextActivities = normalizeActivities(
            [...thread.activities, sequencedActivity],
            thread.activities,
            { cap: state.threadDetailSyncById?.[event.payload.threadId] !== "synced" },
          );
          const pendingInteractions = reconcilePendingInteractionsFromActivity(
            thread.id,
            thread.pendingInteractions,
            event,
          );
          if (
            nextActivities === thread.activities &&
            pendingInteractions === thread.pendingInteractions
          ) {
            return thread;
          }
          return {
            ...thread,
            activities: nextActivities,
            ...(pendingInteractions !== undefined ? { pendingInteractions } : {}),
            updatedAt:
              (thread.updatedAt ?? thread.createdAt) > sequencedActivity.createdAt
                ? thread.updatedAt
                : sequencedActivity.createdAt,
          };
        },
        {
          capActivities: state.threadDetailSyncById?.[event.payload.threadId] !== "synced",
          ...options,
          recomputeSummarySignals: threadActivityUpdatesSummary(event),
          updateSidebarSummary:
            options?.updateSidebarSummary === true || threadActivityUpdatesSummary(event),
        },
      );

    case "thread.conversation-rolled-back":
      if (event.payload.numTurns === 0) {
        return state;
      }
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          const rollback = rollbackThreadMessagesFromMessage(
            thread.messages,
            event.payload.messageId,
          );
          const removedTurnIds = new Set([
            ...rollback.removedTurnIds,
            ...(event.payload.removedTurnIds ?? []),
          ]);
          if (rollback.messages.length === thread.messages.length && removedTurnIds.size === 0) {
            return thread;
          }

          const activities = thread.activities.filter(
            (activity) => activity.turnId === null || !removedTurnIds.has(activity.turnId),
          );

          return {
            ...thread,
            messages: rollback.messages.slice(-MAX_THREAD_MESSAGES),
            activities,
            latestTurn: null,
            updatedAt:
              (thread.updatedAt ?? thread.createdAt) > event.occurredAt
                ? thread.updatedAt
                : event.occurredAt,
          };
        },
        {
          ...options,
          updateSidebarSummary: true,
        },
      );

    default:
      return state;
  }
}

function applyThreadActivityEventBatch(
  state: AppState,
  events: ReadonlyArray<ThreadActivityAppendedEvent>,
  options: ApplyOrchestrationEventOptions,
): AppState {
  const firstEvent = events[0];
  if (!firstEvent) {
    return state;
  }
  const updatesSummary = events.some(threadActivityUpdatesSummary);
  return applyThreadUpdate(
    state,
    firstEvent.payload.threadId,
    (thread) => {
      // One accumulator for the whole batch: appending N activities used to re-normalize the
      // full activity list N times (O(batch x activities)); it is now O(batch) amortised.
      const activityAccumulator = createThreadActivityAccumulator(thread.activities, {
        cap: state.threadDetailSyncById?.[firstEvent.payload.threadId] !== "synced",
      });
      let nextPendingInteractions = thread.pendingInteractions;
      let updatedAt = thread.updatedAt ?? thread.createdAt;
      for (const event of events) {
        const sequencedActivity = withOrchestrationEventSequence(
          event.payload.activity,
          event.sequence,
        );
        const activitiesChanged = activityAccumulator.append(sequencedActivity);
        const reconciledPendingInteractions = reconcilePendingInteractionsFromActivity(
          thread.id,
          nextPendingInteractions,
          event,
        );
        const changed =
          activitiesChanged || reconciledPendingInteractions !== nextPendingInteractions;
        nextPendingInteractions = reconciledPendingInteractions;
        if (changed && sequencedActivity.createdAt > updatedAt) {
          updatedAt = sequencedActivity.createdAt;
        }
      }
      const nextActivities = activityAccumulator.result();
      if (
        nextActivities === thread.activities &&
        nextPendingInteractions === thread.pendingInteractions
      ) {
        return thread;
      }
      return {
        ...thread,
        activities: nextActivities,
        ...(nextPendingInteractions !== undefined
          ? { pendingInteractions: nextPendingInteractions }
          : {}),
        updatedAt,
      };
    },
    {
      capActivities: state.threadDetailSyncById?.[firstEvent.payload.threadId] !== "synced",
      ...options,
      recomputeSummarySignals: updatesSummary,
      updateSidebarSummary: options.updateSidebarSummary === true || updatesSummary,
    },
  );
}

export function applyOrchestrationEvents(
  state: AppState,
  events: ReadonlyArray<OrchestrationEvent>,
): AppState {
  return applyOrchestrationEventsHotPath(state, events, {
    updateSidebarSummary: false,
  });
}

export function applyOrchestrationEventsHotPath(
  state: AppState,
  events: ReadonlyArray<OrchestrationEvent>,
  options?: ApplyOrchestrationEventOptions,
): AppState {
  const normalizedOptions = {
    updateSidebarSummary: options?.updateSidebarSummary ?? false,
  };
  let nextState = state;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.type === "thread.activity-appended") {
      const activityEvents = [event];
      while (index + 1 < events.length) {
        const nextEvent = events[index + 1];
        if (
          nextEvent?.type !== "thread.activity-appended" ||
          nextEvent.payload.threadId !== event.payload.threadId
        ) {
          break;
        }
        activityEvents.push(nextEvent);
        index += 1;
      }
      nextState = applyThreadActivityEventBatch(nextState, activityEvents, normalizedOptions);
      continue;
    }
    nextState = applyOrchestrationEvent(nextState, event, normalizedOptions);
  }
  return nextState;
}
