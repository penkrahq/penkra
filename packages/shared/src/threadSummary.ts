import type { OrchestrationMessage, OrchestrationThreadActivity } from "@penkra/contracts";

export interface ThreadSummaryMetadata {
  latestUserMessageAt: string | null;
  hasPendingUserInput: boolean;
}

export interface ThreadSummaryState extends ThreadSummaryMetadata {
  pendingUserInputCount: number;
}

export interface PendingThreadRequestIds {
  userInputRequestIds: ReadonlyArray<string>;
}

export const PENDING_INTERACTION_NOT_FOUND_FAILURE_CODE = "PENDING_INTERACTION_NOT_FOUND" as const;

export function pendingRequestInstanceKey(requestId: string, lifecycleGeneration?: string): string {
  return `${requestId}\u0000${lifecycleGeneration ?? "legacy"}`;
}

function maxIso(left: string | null, right: string): string {
  if (left === null) {
    return right;
  }
  return left > right ? left : right;
}

function compareActivitiesByOrder(
  left: Pick<OrchestrationThreadActivity, "createdAt" | "id" | "sequence">,
  right: Pick<OrchestrationThreadActivity, "createdAt" | "id" | "sequence">,
): number {
  const leftSequence = left.sequence ?? Number.MAX_SAFE_INTEGER;
  const rightSequence = right.sequence ?? Number.MAX_SAFE_INTEGER;
  return (
    leftSequence - rightSequence ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

function toPayloadRecord(payload: unknown): Record<string, unknown> | null {
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
}

export function isPendingInteractionNotFoundFailure(payload: unknown): boolean {
  return toPayloadRecord(payload)?.failureCode === PENDING_INTERACTION_NOT_FOUND_FAILURE_CODE;
}

function lifecycleGenerationFromPayload(
  payload: Record<string, unknown> | null,
): string | undefined {
  const generation = payload?.lifecycleGeneration;
  return typeof generation === "string" && generation.length > 0 ? generation : undefined;
}

function deleteOpenRequest(
  openRequests: Map<string, string>,
  requestId: string,
  lifecycleGeneration: string | undefined,
): void {
  if (lifecycleGeneration !== undefined) {
    openRequests.delete(pendingRequestInstanceKey(requestId, lifecycleGeneration));
    return;
  }
  for (const [key, openRequestId] of openRequests) {
    if (openRequestId === requestId) openRequests.delete(key);
  }
}

function replaceOpenRequest(
  openRequests: Map<string, string>,
  requestId: string,
  lifecycleGeneration: string | undefined,
): void {
  deleteOpenRequest(openRequests, requestId, undefined);
  openRequests.set(pendingRequestInstanceKey(requestId, lifecycleGeneration), requestId);
}

function hasStructuredUserInputQuestions(payload: Record<string, unknown> | null): boolean {
  const questions = payload?.questions;
  if (!Array.isArray(questions)) {
    return false;
  }
  return questions.some((entry) => {
    if (!entry || typeof entry !== "object") {
      return false;
    }
    const question = entry as Record<string, unknown>;
    const options = Array.isArray(question.options) ? question.options : null;
    return (
      typeof question.id === "string" &&
      typeof question.header === "string" &&
      typeof question.question === "string" &&
      options !== null &&
      options.some((option) => {
        if (!option || typeof option !== "object") {
          return false;
        }
        const optionRecord = option as Record<string, unknown>;
        return (
          typeof optionRecord.label === "string" && typeof optionRecord.description === "string"
        );
      })
    );
  });
}

// Tracks the open question lifecycles from timeline activities.
export function derivePendingThreadRequestIds(input: {
  readonly activities: ReadonlyArray<
    Pick<OrchestrationThreadActivity, "createdAt" | "id" | "kind" | "payload" | "sequence">
  >;
}): PendingThreadRequestIds {
  const openUserInputs = new Map<string, string>();
  const orderedActivities = [...input.activities].toSorted(compareActivitiesByOrder);
  for (const activity of orderedActivities) {
    const payload = toPayloadRecord(activity.payload);
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : null;
    const lifecycleGeneration = lifecycleGenerationFromPayload(payload);

    if (activity.kind === "user-input.requested" && requestId) {
      if (hasStructuredUserInputQuestions(payload)) {
        replaceOpenRequest(openUserInputs, requestId, lifecycleGeneration);
      }
      continue;
    }

    if (activity.kind === "user-input.resolved" && requestId) {
      deleteOpenRequest(openUserInputs, requestId, lifecycleGeneration);
      continue;
    }

    if (
      activity.kind === "provider.user-input.respond.failed" &&
      requestId &&
      isPendingInteractionNotFoundFailure(payload)
    ) {
      deleteOpenRequest(openUserInputs, requestId, lifecycleGeneration);
    }
  }

  return {
    userInputRequestIds: [...openUserInputs.values()],
  };
}

export function deriveThreadSummaryState(input: {
  readonly messages: ReadonlyArray<Pick<OrchestrationMessage, "role" | "createdAt" | "origin">>;
  readonly activities: ReadonlyArray<
    Pick<OrchestrationThreadActivity, "createdAt" | "id" | "kind" | "payload" | "sequence">
  >;
}): ThreadSummaryState {
  let latestUserMessageAt: string | null = null;
  for (const message of input.messages) {
    if (message.role === "user" && message.origin?._tag !== "recovery") {
      latestUserMessageAt = maxIso(latestUserMessageAt, message.createdAt);
    }
  }

  const pendingRequestIds = derivePendingThreadRequestIds({ activities: input.activities });

  return {
    latestUserMessageAt,
    pendingUserInputCount: pendingRequestIds.userInputRequestIds.length,
    hasPendingUserInput: pendingRequestIds.userInputRequestIds.length > 0,
  };
}

export function deriveThreadSummaryMetadata(input: {
  readonly messages: ReadonlyArray<Pick<OrchestrationMessage, "role" | "createdAt" | "origin">>;
  readonly activities: ReadonlyArray<
    Pick<OrchestrationThreadActivity, "createdAt" | "id" | "kind" | "payload" | "sequence">
  >;
}): ThreadSummaryMetadata {
  const summary = deriveThreadSummaryState(input);
  return {
    latestUserMessageAt: summary.latestUserMessageAt,
    hasPendingUserInput: summary.hasPendingUserInput,
  };
}
