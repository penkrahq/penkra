import {
  ApprovalRequestId,
  type OrchestrationPendingInteraction,
  type OrchestrationThreadActivity,
  type UserInputQuestion,
} from "@penkra/contracts";
import {
  approvalRequestKindFromRequestType,
  isPendingInteractionNotFoundFailure,
  pendingRequestInstanceKey,
} from "@penkra/shared/threadSummary";
import { orderedActivities } from "./workLog";

export interface PendingApproval {
  requestId: ApprovalRequestId;
  lifecycleGeneration?: string;
  requestKind: "command" | "file-read" | "file-change";
  createdAt: string;
  detail?: string;
}

export interface PendingUserInput {
  requestId: ApprovalRequestId;
  lifecycleGeneration?: string;
  createdAt: string;
  questions: ReadonlyArray<UserInputQuestion>;
}

export interface ExpiredUserInput extends PendingUserInput {
  expiredAt: string;
  answers: Record<string, string | string[]>;
}

// Keep recovery content separate from the actionable request set. A failed
// response is never presented as a provider-confirmed answer.
export function deriveExpiredUserInputs(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ExpiredUserInput[] {
  const requested = new Map<string, PendingUserInput>();
  const expired = new Map<string, ExpiredUserInput>();
  const answers = new Map<string, Record<string, string | string[]>>();
  for (const activity of orderedActivities(activities)) {
    const payload = activityPayload(activity);
    if (typeof payload?.requestId !== "string") continue;
    const requestId = ApprovalRequestId.makeUnsafe(payload.requestId);
    const lifecycleGeneration = activityLifecycleGeneration(payload);
    const key =
      lifecycleGeneration === undefined && activity.kind !== "user-input.requested"
        ? ([...requested.entries()].findLast(([, prompt]) => prompt.requestId === requestId)?.[0] ??
          pendingRequestInstanceKey(requestId, lifecycleGeneration))
        : pendingRequestInstanceKey(requestId, lifecycleGeneration);
    const questions = parseUserInputQuestions(payload);
    if (activity.kind === "user-input.requested" && questions) {
      for (const [previousKey, previous] of requested) {
        if (previous.requestId === requestId && previousKey !== key) {
          requested.delete(previousKey);
          expired.delete(previousKey);
        }
      }
      requested.set(key, {
        requestId,
        ...(lifecycleGeneration === undefined ? {} : { lifecycleGeneration }),
        questions,
        createdAt: activity.createdAt,
      });
      expired.delete(key);
    }
    if (activity.kind === "provider.user-input.respond.failed") {
      if (payload.answers && typeof payload.answers === "object") {
        answers.set(
          key,
          Object.fromEntries(
            Object.entries(payload.answers).filter(
              (entry): entry is [string, string | string[]] =>
                typeof entry[1] === "string" ||
                (Array.isArray(entry[1]) && entry[1].every((value) => typeof value === "string")),
            ),
          ),
        );
      }
      if (!isPendingInteractionNotFoundFailure(payload)) continue;
      if (
        [...requested.entries()].some(
          ([currentKey, current]) => current.requestId === requestId && currentKey !== key,
        )
      )
        continue;
      const original =
        requested.get(key) ??
        (questions
          ? {
              requestId,
              ...(lifecycleGeneration === undefined ? {} : { lifecycleGeneration }),
              questions,
              createdAt: activity.createdAt,
            }
          : undefined);
      if (original)
        expired.set(key, {
          ...original,
          expiredAt: activity.createdAt,
          answers: answers.get(key) ?? {},
        });
    }
    if (activity.kind === "user-input.resolved") expired.delete(key);
  }
  return [...expired.values()];
}

type PendingInteractionKind = OrchestrationPendingInteraction["interactionKind"];

interface PendingInteractionReplay<T extends { requestId: ApprovalRequestId }> {
  interactionKind: PendingInteractionKind;
  requestedActivityKind: string;
  resolvedActivityKind: string;
  responseFailedActivityKind: string;
  parseRequested: (input: {
    activity: OrchestrationThreadActivity;
    payload: Record<string, unknown> | null;
    requestId: ApprovalRequestId;
    lifecycleGeneration: string | undefined;
  }) => T | null;
}

function activityPayload(activity: OrchestrationThreadActivity): Record<string, unknown> | null {
  return activity.payload && typeof activity.payload === "object"
    ? (activity.payload as Record<string, unknown>)
    : null;
}

function activityLifecycleGeneration(payload: Record<string, unknown> | null): string | undefined {
  const generation = payload?.lifecycleGeneration;
  return typeof generation === "string" && generation.length > 0 ? generation : undefined;
}

function deletePendingInteraction<T extends { requestId: ApprovalRequestId }>(
  openByInstance: Map<string, T>,
  requestId: ApprovalRequestId,
  lifecycleGeneration: string | undefined,
): void {
  if (lifecycleGeneration !== undefined) {
    openByInstance.delete(pendingRequestInstanceKey(requestId, lifecycleGeneration));
    return;
  }
  for (const [key, pending] of openByInstance) {
    if (pending.requestId === requestId) openByInstance.delete(key);
  }
}

function replacePendingInteraction<T extends { requestId: ApprovalRequestId }>(
  openByInstance: Map<string, T>,
  pending: T,
  lifecycleGeneration: string | undefined,
): void {
  deletePendingInteraction(openByInstance, pending.requestId, undefined);
  openByInstance.set(pendingRequestInstanceKey(pending.requestId, lifecycleGeneration), pending);
}

function retainActionableSettlements<T extends { requestId: ApprovalRequestId }>(
  openByInstance: Map<string, T>,
  settlements: ReadonlyArray<OrchestrationPendingInteraction> | undefined,
  interactionKind: PendingInteractionKind,
): void {
  if (settlements === undefined) {
    return;
  }
  const actionableKeys = new Set(
    settlements
      .filter(
        (settlement) =>
          settlement.interactionKind === interactionKind &&
          (settlement.status === "pending" || settlement.status === "retryable"),
      )
      .map((settlement) =>
        pendingRequestInstanceKey(
          settlement.requestId,
          settlement.lifecycleGeneration ?? undefined,
        ),
      ),
  );
  for (const key of openByInstance.keys()) {
    if (!actionableKeys.has(key)) {
      openByInstance.delete(key);
    }
  }
}

function replayPendingInteractions<T extends { requestId: ApprovalRequestId; createdAt: string }>(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  settlements: ReadonlyArray<OrchestrationPendingInteraction> | undefined,
  replay: PendingInteractionReplay<T>,
): T[] {
  const openByInstance = new Map<string, T>();

  for (const activity of orderedActivities(activities)) {
    const payload = activityPayload(activity);
    const requestId =
      typeof payload?.requestId === "string"
        ? ApprovalRequestId.makeUnsafe(payload.requestId)
        : null;
    if (!requestId) {
      continue;
    }

    const lifecycleGeneration = activityLifecycleGeneration(payload);
    if (activity.kind === replay.requestedActivityKind) {
      const pending = replay.parseRequested({
        activity,
        payload,
        requestId,
        lifecycleGeneration,
      });
      if (pending) {
        replacePendingInteraction(openByInstance, pending, lifecycleGeneration);
      }
      continue;
    }

    if (activity.kind === replay.resolvedActivityKind) {
      deletePendingInteraction(openByInstance, requestId, lifecycleGeneration);
      continue;
    }

    if (
      activity.kind === replay.responseFailedActivityKind &&
      isPendingInteractionNotFoundFailure(payload)
    ) {
      deletePendingInteraction(openByInstance, requestId, lifecycleGeneration);
    }
  }

  retainActionableSettlements(openByInstance, settlements, replay.interactionKind);
  return [...openByInstance.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

function parseUserInputQuestions(
  payload: Record<string, unknown> | null,
): ReadonlyArray<UserInputQuestion> | null {
  const questions = payload?.questions;
  if (!Array.isArray(questions)) {
    return null;
  }
  const parsed = questions
    .map<UserInputQuestion | null>((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const question = entry as Record<string, unknown>;
      if (
        typeof question.id !== "string" ||
        typeof question.header !== "string" ||
        typeof question.question !== "string" ||
        !Array.isArray(question.options)
      ) {
        return null;
      }
      const options = question.options
        .map<UserInputQuestion["options"][number] | null>((option) => {
          if (!option || typeof option !== "object") return null;
          const optionRecord = option as Record<string, unknown>;
          if (
            typeof optionRecord.label !== "string" ||
            typeof optionRecord.description !== "string"
          ) {
            return null;
          }
          return {
            label: optionRecord.label,
            description: optionRecord.description,
          };
        })
        .filter((option): option is UserInputQuestion["options"][number] => option !== null);
      return {
        id: question.id,
        header: question.header,
        question: question.question,
        options,
        ...(question.multiSelect === true ? { multiSelect: true } : {}),
      };
    })
    .filter((question): question is UserInputQuestion => question !== null);
  return parsed.length > 0 ? parsed : null;
}

export function derivePendingApprovals(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  settlements?: ReadonlyArray<OrchestrationPendingInteraction>,
): PendingApproval[] {
  return replayPendingInteractions(activities, settlements, {
    interactionKind: "approval",
    requestedActivityKind: "approval.requested",
    resolvedActivityKind: "approval.resolved",
    responseFailedActivityKind: "provider.approval.respond.failed",
    parseRequested: ({ activity, payload, requestId, lifecycleGeneration }) => {
      const requestKind =
        payload?.requestKind === "command" ||
        payload?.requestKind === "file-read" ||
        payload?.requestKind === "file-change"
          ? payload.requestKind
          : approvalRequestKindFromRequestType(payload?.requestType);
      if (!requestKind) {
        return null;
      }
      const detail = typeof payload?.detail === "string" ? payload.detail : undefined;
      return {
        requestId,
        ...(lifecycleGeneration !== undefined ? { lifecycleGeneration } : {}),
        requestKind,
        createdAt: activity.createdAt,
        ...(detail ? { detail } : {}),
      };
    },
  });
}

export function derivePendingUserInputs(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  settlements?: ReadonlyArray<OrchestrationPendingInteraction>,
): PendingUserInput[] {
  return replayPendingInteractions(activities, settlements, {
    interactionKind: "userInput",
    requestedActivityKind: "user-input.requested",
    resolvedActivityKind: "user-input.resolved",
    responseFailedActivityKind: "provider.user-input.respond.failed",
    parseRequested: ({ activity, payload, requestId, lifecycleGeneration }) => {
      const questions = parseUserInputQuestions(payload);
      if (!questions) {
        return null;
      }
      return {
        requestId,
        ...(lifecycleGeneration !== undefined ? { lifecycleGeneration } : {}),
        createdAt: activity.createdAt,
        questions,
      };
    },
  });
}
