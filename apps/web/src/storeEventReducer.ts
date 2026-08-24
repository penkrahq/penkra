// FILE: storeEventReducer.ts
// Purpose: Reduces ordered orchestration domain events into normalized client state.
// Exports: Normal and hot-path event batch reducers.

import {
  type OrchestrationEvent,
  type OrchestrationPendingInteraction,
  type ThreadId,
} from "@penkra/contracts";
import {
  addPinnedMessage,
  removePinnedMessage,
  setPinnedMessageDone,
  setPinnedMessageLabel,
} from "@penkra/shared/pinnedMessages";

import { isSessionRunningTurn, latestTurnMatchesTurnId } from "./session-logic";
import {
  MAX_THREAD_MESSAGES,
  arraysShallowEqual,
  asActivityRecord,
  createThreadActivityAccumulator,
  deepEqualJson,
  normalizeActivities,
  normalizeChatMessage,
  normalizeModelSelection,
  normalizeThreadErrorMessage,
  normalizeThreadSession,
  providerReferenceArraysEqual,
  withOrchestrationEventSequence,
} from "./storeNormalization";
import {
  applySpaceOrder,
  applyThreadUpdate,
  removeSpace,
  removeDeletedProjectFromClientState,
  removeDeletedThreadFromClientState,
  upsertProject,
  upsertSpace,
} from "./storeProjection";
import type { AppState } from "./storeState";
import type { ChatMessage, Thread } from "./types";

type ThreadMessageSentEvent = Extract<OrchestrationEvent, { type: "thread.message-sent" }>;
type ThreadActivityAppendedEvent = Extract<
  OrchestrationEvent,
  { type: "thread.activity-appended" }
>;
type ThreadApprovalResponseRequestedEvent = Extract<
  OrchestrationEvent,
  { type: "thread.approval-response-requested" }
>;
type ThreadUserInputResponseRequestedEvent = Extract<
  OrchestrationEvent,
  { type: "thread.user-input-response-requested" }
>;
export type ApplyOrchestrationEventOptions = {
  updateSidebarSummary?: boolean;
};

type ReadModelThread = import("@penkra/contracts").OrchestrationReadModel["threads"][number];

const THREAD_SUMMARY_ACTIVITY_KINDS = new Set([
  "approval.requested",
  "approval.resolved",
  "provider.approval.respond.failed",
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

function markInteractionResponding(
  thread: Thread,
  event: ThreadUserInputResponseRequestedEvent | ThreadApprovalResponseRequestedEvent,
): Thread["pendingInteractions"] {
  if (thread.pendingInteractions === undefined || event.commandId === null) {
    return thread.pendingInteractions;
  }
  const interactionKind =
    event.type === "thread.approval-response-requested" ? "approval" : "userInput";
  const lifecycleGeneration = event.payload.lifecycleGeneration ?? null;
  let changed = false;
  const next = thread.pendingInteractions.map((interaction) => {
    if (
      interaction.interactionKind !== interactionKind ||
      interaction.requestId !== event.payload.requestId ||
      interaction.lifecycleGeneration !== lifecycleGeneration ||
      (interaction.status !== "pending" && interaction.status !== "retryable")
    ) {
      return interaction;
    }
    changed = true;
    return {
      ...interaction,
      status: "responding" as const,
      decision: event.type === "thread.approval-response-requested" ? event.payload.decision : null,
      responseCommandId: event.commandId,
      responseRequestedAt: event.payload.createdAt,
      resolvedAt: null,
    };
  });
  return changed ? next : thread.pendingInteractions;
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
    activity.kind === "approval.requested" ||
    activity.kind === "approval.resolved" ||
    activity.kind === "provider.approval.respond.failed"
      ? ("approval" as const)
      : activity.kind === "user-input.requested" ||
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

  if (activity.kind === "approval.resolved" || activity.kind === "user-input.resolved") {
    const next = existing.filter((interaction) => !matchesIdentity(interaction));
    return next.length === existing.length ? pendingInteractions : next;
  }

  if (
    activity.kind === "provider.approval.respond.failed" ||
    activity.kind === "provider.user-input.respond.failed"
  ) {
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
    decision: null,
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
  state: NonNullable<Thread["latestTurn"]>["state"];
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  assistantMessageId: NonNullable<Thread["latestTurn"]>["assistantMessageId"];
}): NonNullable<Thread["latestTurn"]> {
  const providerTurnId =
    params.previous?.turnId === params.turnId ? params.previous.providerTurnId : undefined;
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
  if (isSessionRunningTurn(session)) {
    const matchedLatestTurn = latestTurnMatchesTurnId(thread.latestTurn, session.activeTurnId)
      ? thread.latestTurn
      : null;
    return buildLatestTurn({
      previous: thread.latestTurn,
      turnId: matchedLatestTurn?.turnId ?? session.activeTurnId,
      state: "running",
      requestedAt: matchedLatestTurn?.requestedAt ?? session.updatedAt,
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
    thread.latestTurn?.state === "running" &&
    (session.activeTurnId == null || settledState === "error")
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
    existingMessage.delivery === nextDelivery &&
    existingMessage.source === nextSource
  ) {
    return null;
  }

  return {
    ...existingMessage,
    text: nextText,
    streaming: incomingMessage.streaming,
    ...(nextAttachments ? { attachments: nextAttachments } : {}),
    ...(nextSkills && nextSkills.length > 0 ? { skills: [...nextSkills] } : {}),
    ...(nextMentions && nextMentions.length > 0 ? { mentions: [...nextMentions] } : {}),
    ...(nextTurnId !== undefined ? { turnId: nextTurnId } : {}),
    ...(nextDispatchMode !== undefined ? { dispatchMode: nextDispatchMode } : {}),
    ...(nextDispatchOrigin !== undefined ? { dispatchOrigin: nextDispatchOrigin } : {}),
    ...(nextDelivery !== undefined ? { delivery: nextDelivery } : {}),
    ...(nextSource !== undefined ? { source: nextSource } : {}),
    ...(nextCompletedAt !== undefined ? { completedAt: nextCompletedAt } : {}),
  };
}

function applyThreadMessageSentEvent(thread: Thread, event: ThreadMessageSentEvent): Thread {
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
      ...(payload.delivery !== undefined
        ? { delivery: { ...payload.delivery, sequence: event.sequence } }
        : {}),
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
    messages = [...thread.messages, incomingMessage].slice(-MAX_THREAD_MESSAGES);
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
    case "space.created":
      return upsertSpace(state, {
        id: event.payload.spaceId,
        name: event.payload.name,
        icon: event.payload.icon,
        sortOrder: event.payload.sortOrder,
        createdAt: event.payload.createdAt,
        updatedAt: event.payload.updatedAt,
      });

    case "space.updated": {
      const existing = state.spaces.find((space) => space.id === event.payload.spaceId);
      const updatedState = existing
        ? upsertSpace(state, {
            ...existing,
            name: event.payload.name ?? existing.name,
            icon: event.payload.icon ?? existing.icon,
            updatedAt: event.payload.updatedAt,
          })
        : state;
      return event.payload.orderedSpaceIds === undefined
        ? updatedState
        : applySpaceOrder(updatedState, event.payload.orderedSpaceIds, event.payload.updatedAt);
    }

    case "space.archived":
      return removeSpace(state, event.payload.spaceId, event.payload.archivedAt, true);

    case "space.restored":
      // The shell stream supplies the restored row with its full name/icon/order metadata.
      return state;

    case "space.deleted":
      return removeSpace(state, event.payload.spaceId, event.payload.deletedAt);

    case "folder.created":
      return upsertProject(
        state,
        {
          id: event.payload.folderId,
          title: event.payload.title,
          workspaceRoot: event.payload.workspaceRoot,
          defaultModelSelection: event.payload.defaultModelSelection,
          scripts: event.payload.scripts,
          iconDataUrl: event.payload.iconDataUrl ?? null,
          isPinned: event.payload.isPinned ?? false,
          spaceId: event.payload.spaceId,
          createdAt: event.payload.createdAt,
          updatedAt: event.payload.updatedAt,
        },
        "id-only",
      );

    case "folder.updated": {
      const existingProject = state.folders.find(
        (project) => project.id === event.payload.folderId,
      );
      if (!existingProject) {
        return state;
      }
      return upsertProject(
        state,
        {
          id: existingProject.id,
          title: event.payload.title ?? existingProject.remoteName,
          workspaceRoot:
            event.payload.workspaceRoot !== undefined
              ? event.payload.workspaceRoot
              : existingProject.cwd || null,
          defaultModelSelection:
            event.payload.defaultModelSelection !== undefined
              ? event.payload.defaultModelSelection
              : existingProject.defaultModelSelection,
          scripts: event.payload.scripts ?? existingProject.scripts,
          iconDataUrl:
            event.payload.iconDataUrl !== undefined
              ? event.payload.iconDataUrl
              : existingProject.iconDataUrl,
          isPinned: event.payload.isPinned ?? existingProject.isPinned ?? false,
          spaceId: existingProject.spaceId,
          createdAt: existingProject.createdAt ?? event.payload.updatedAt,
          updatedAt: event.payload.updatedAt,
        },
        "id-only",
      );
    }

    case "folder.moved": {
      const existingFolder = state.folders.find((folder) => folder.id === event.payload.folderId);
      return existingFolder
        ? upsertProject(
            state,
            {
              id: existingFolder.id,
              title: existingFolder.remoteName,
              workspaceRoot: existingFolder.cwd || null,
              defaultModelSelection: existingFolder.defaultModelSelection,
              scripts: existingFolder.scripts,
              iconDataUrl: existingFolder.iconDataUrl,
              isPinned: existingFolder.isPinned ?? false,
              spaceId: event.payload.spaceId,
              sidebarSortOrder: existingFolder.sidebarSortOrder,
              createdAt: existingFolder.createdAt ?? event.payload.updatedAt,
              updatedAt: event.payload.updatedAt,
              archivedAt: existingFolder.archivedAt ?? null,
            },
            "id-only",
          )
        : state;
    }

    case "folder.deleted": {
      return removeDeletedProjectFromClientState(state, event.payload.folderId, event.sequence);
    }

    case "thread.deleted":
      // Deletion is terminal for both active sidebar rows and archived settings rows.
      return removeDeletedThreadFromClientState(state, event.payload.threadId, event.sequence);

    case "thread.updated":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          const modelSelection =
            event.payload.modelSelection !== undefined
              ? normalizeModelSelection(event.payload.modelSelection, thread.modelSelection)
              : thread.modelSelection;
          const nextWorkingDirectory =
            event.payload.workingDirectory !== undefined
              ? event.payload.workingDirectory
              : (thread.workingDirectory ?? null);
          const nextUpdatedAt =
            (thread.updatedAt ?? thread.createdAt) > event.payload.updatedAt
              ? thread.updatedAt
              : event.payload.updatedAt;
          const cwdChanged = (thread.workingDirectory ?? null) !== nextWorkingDirectory;

          if (
            (event.payload.title === undefined || event.payload.title === thread.title) &&
            modelSelection === thread.modelSelection &&
            nextWorkingDirectory === (thread.workingDirectory ?? null) &&
            (event.payload.isPinned === undefined ||
              event.payload.isPinned === (thread.isPinned ?? false)) &&
            (event.payload.parentThreadId === undefined ||
              (event.payload.parentThreadId ?? null) === (thread.parentThreadId ?? null)) &&
            (event.payload.subagentAgentId === undefined ||
              (event.payload.subagentAgentId ?? null) === (thread.subagentAgentId ?? null)) &&
            (event.payload.subagentNickname === undefined ||
              (event.payload.subagentNickname ?? null) === (thread.subagentNickname ?? null)) &&
            (event.payload.subagentRole === undefined ||
              (event.payload.subagentRole ?? null) === (thread.subagentRole ?? null)) &&
            (event.payload.pinnedMessages === undefined ||
              deepEqualJson(event.payload.pinnedMessages, thread.pinnedMessages ?? null)) &&
            (event.payload.notes === undefined || event.payload.notes === (thread.notes ?? "")) &&
            nextUpdatedAt === thread.updatedAt
          ) {
            return thread;
          }

          return {
            ...thread,
            ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
            modelSelection,
            workingDirectory: nextWorkingDirectory,
            ...(event.payload.isPinned !== undefined ? { isPinned: event.payload.isPinned } : {}),
            ...(event.payload.parentThreadId !== undefined
              ? { parentThreadId: event.payload.parentThreadId }
              : {}),
            ...(event.payload.subagentAgentId !== undefined
              ? { subagentAgentId: event.payload.subagentAgentId }
              : {}),
            ...(event.payload.subagentNickname !== undefined
              ? { subagentNickname: event.payload.subagentNickname }
              : {}),
            ...(event.payload.subagentRole !== undefined
              ? { subagentRole: event.payload.subagentRole }
              : {}),
            ...(event.payload.pinnedMessages !== undefined
              ? {
                  pinnedMessages: event.payload.pinnedMessages as NonNullable<
                    Thread["pinnedMessages"]
                  >,
                }
              : {}),
            ...(event.payload.notes !== undefined ? { notes: event.payload.notes } : {}),
            updatedAt: nextUpdatedAt,
            ...(cwdChanged ? { session: null } : {}),
          };
        },
        {
          ...options,
          updateSidebarSummary: true,
        },
      );

    case "thread.pinned-message-added":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          const pinnedMessages = addPinnedMessage(thread.pinnedMessages, event.payload.pin);
          const updatedAt = resolveEventUpdatedAt(thread, event.payload.updatedAt);
          if (thread.pinnedMessages === pinnedMessages && thread.updatedAt === updatedAt) {
            return thread;
          }
          return {
            ...thread,
            pinnedMessages,
            updatedAt,
          };
        },
        { ...options, updateSidebarSummary: false },
      );

    case "thread.pinned-message-removed":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          const pinnedMessages = removePinnedMessage(
            thread.pinnedMessages,
            event.payload.messageId,
          );
          const updatedAt = resolveEventUpdatedAt(thread, event.payload.updatedAt);
          if (thread.pinnedMessages === pinnedMessages && thread.updatedAt === updatedAt) {
            return thread;
          }
          return {
            ...thread,
            pinnedMessages,
            updatedAt,
          };
        },
        { ...options, updateSidebarSummary: false },
      );

    case "thread.pinned-message-done-set":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          const pinnedMessages = setPinnedMessageDone(
            thread.pinnedMessages,
            event.payload.messageId,
            event.payload.done,
          );
          const updatedAt = resolveEventUpdatedAt(thread, event.payload.updatedAt);
          if (thread.pinnedMessages === pinnedMessages && thread.updatedAt === updatedAt) {
            return thread;
          }
          return {
            ...thread,
            pinnedMessages,
            updatedAt,
          };
        },
        { ...options, updateSidebarSummary: false },
      );

    case "thread.pinned-message-label-set":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          const pinnedMessages = setPinnedMessageLabel(
            thread.pinnedMessages,
            event.payload.messageId,
            event.payload.label,
          );
          const updatedAt = resolveEventUpdatedAt(thread, event.payload.updatedAt);
          if (thread.pinnedMessages === pinnedMessages && thread.updatedAt === updatedAt) {
            return thread;
          }
          return {
            ...thread,
            pinnedMessages,
            updatedAt,
          };
        },
        { ...options, updateSidebarSummary: false },
      );

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
        (thread) => applyThreadMessageSentEvent(thread, event),
        {
          ...options,
          recomputeSummarySignals: threadMessageUpdatesSummary(event),
          updateSidebarSummary:
            options?.updateSidebarSummary === true || threadMessageUpdatesSidebarSummary(event),
        },
      );

    case "thread.message-delivery-set":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => ({
          ...thread,
          messages: thread.messages.map((message) =>
            message.id === event.payload.messageId &&
            message.delivery !== undefined &&
            event.sequence >= message.delivery.sequence
              ? {
                  ...message,
                  delivery: {
                    ...message.delivery,
                    state: event.payload.state,
                    sequence: event.sequence,
                  },
                  completedAt: event.payload.updatedAt,
                }
              : message,
          ),
          updatedAt: resolveEventUpdatedAt(thread, event.payload.updatedAt),
        }),
        { ...options, updateSidebarSummary: false },
      );

    case "thread.session-set":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          const session = normalizeThreadSession(event.payload.session, thread.session);
          const error = normalizeThreadErrorMessage(event.payload.session.lastError);
          const latestTurn = reconcileLatestTurnFromSession(thread, event.payload.session, error);
          const pendingTurnStartMessageId =
            event.payload.session.status === "starting"
              ? (thread.pendingTurnStartMessageId ?? null)
              : null;
          if (
            session === thread.session &&
            error === thread.error &&
            latestTurn === thread.latestTurn &&
            pendingTurnStartMessageId === (thread.pendingTurnStartMessageId ?? null)
          ) {
            return thread;
          }
          return {
            ...thread,
            session,
            error,
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

    case "thread.turn-steer-queued-requested":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => ({
          ...thread,
          messages: thread.messages.map((message) =>
            message.id === event.payload.messageId &&
            message.delivery !== undefined &&
            event.sequence >= message.delivery.sequence
              ? {
                  ...message,
                  delivery: { ...message.delivery, state: "steering", sequence: event.sequence },
                }
              : message,
          ),
          updatedAt: resolveEventUpdatedAt(thread, event.payload.createdAt),
        }),
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

    case "thread.turn-start-requested":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          const modelSelection =
            event.payload.modelSelection !== undefined
              ? normalizeModelSelection(event.payload.modelSelection, thread.modelSelection)
              : thread.modelSelection;
          const runtimeMode = event.payload.runtimeMode;
          const existingQueuedMessageIds = thread.queuedMessageIds ?? [];
          const queuedMessageIds = existingQueuedMessageIds.filter(
            (messageId) => messageId !== event.payload.messageId,
          );
          if (
            modelSelection === thread.modelSelection &&
            thread.runtimeMode === runtimeMode &&
            thread.pendingTurnStartMessageId === event.payload.messageId &&
            queuedMessageIds.length === existingQueuedMessageIds.length &&
            thread.messages.some(
              (message) =>
                message.id === event.payload.messageId &&
                message.delivery?.state ===
                  (event.payload.dispatchMode === "steer" ? "steering" : "starting") &&
                message.delivery.sequence >= event.sequence,
            ) &&
            (thread.updatedAt ?? thread.createdAt) >= event.payload.createdAt
          ) {
            return thread;
          }
          return {
            ...thread,
            modelSelection,
            runtimeMode,
            messages: thread.messages.map((message) =>
              message.id === event.payload.messageId &&
              message.delivery !== undefined &&
              event.sequence >= message.delivery.sequence
                ? {
                    ...message,
                    delivery: {
                      ...message.delivery,
                      state: event.payload.dispatchMode === "steer" ? "steering" : "starting",
                      sequence: event.sequence,
                    },
                  }
                : message,
            ),
            pendingTurnStartMessageId: event.payload.messageId,
            queuedMessageIds,
            updatedAt:
              (thread.updatedAt ?? thread.createdAt) > event.payload.createdAt
                ? thread.updatedAt
                : event.payload.createdAt,
          };
        },
        {
          ...options,
          updateSidebarSummary: true,
        },
      );

    case "thread.user-input-response-requested":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          const pendingInteractions = markInteractionResponding(thread, event);
          return {
            ...thread,
            ...(pendingInteractions !== undefined ? { pendingInteractions } : {}),
            updatedAt:
              (thread.updatedAt ?? thread.createdAt) > event.payload.createdAt
                ? thread.updatedAt
                : event.payload.createdAt,
          };
        },
        {
          ...options,
          updateSidebarSummary: true,
        },
      );

    case "thread.approval-response-requested":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          const pendingInteractions = markInteractionResponding(thread, event);
          return {
            ...thread,
            ...(pendingInteractions !== undefined ? { pendingInteractions } : {}),
            updatedAt:
              (thread.updatedAt ?? thread.createdAt) > event.payload.createdAt
                ? thread.updatedAt
                : event.payload.createdAt,
          };
        },
        {
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
          ...options,
          recomputeSummarySignals: threadActivityUpdatesSummary(event),
          updateSidebarSummary:
            options?.updateSidebarSummary === true || threadActivityUpdatesSummary(event),
        },
      );

    case "thread.turn-start-cancelled":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          const messages = thread.messages.filter(
            (message) => message.id !== event.payload.messageId,
          );
          const existingQueuedMessageIds = thread.queuedMessageIds ?? [];
          const queuedMessageIds = existingQueuedMessageIds.filter(
            (messageId) => messageId !== event.payload.messageId,
          );
          if (
            messages.length === thread.messages.length &&
            queuedMessageIds.length === existingQueuedMessageIds.length &&
            thread.pendingTurnStartMessageId === null
          ) {
            return thread;
          }
          return {
            ...thread,
            messages,
            queuedMessageIds,
            pendingTurnStartMessageId: null,
            updatedAt:
              (thread.updatedAt ?? thread.createdAt) > event.occurredAt
                ? thread.updatedAt
                : event.occurredAt,
          };
        },
        { ...options, recomputeSummarySignals: true, updateSidebarSummary: true },
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

    case "thread.archived":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => ({
          ...thread,
          archivedAt: event.payload.archivedAt ?? event.occurredAt,
          updatedAt: event.payload.updatedAt ?? event.occurredAt,
        }),
        {
          ...options,
          updateSidebarSummary: true,
        },
      );

    case "thread.unarchived":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => ({
          ...thread,
          archivedAt: null,
          updatedAt: event.payload.updatedAt ?? event.occurredAt,
        }),
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
      const activityAccumulator = createThreadActivityAccumulator(thread.activities);
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
