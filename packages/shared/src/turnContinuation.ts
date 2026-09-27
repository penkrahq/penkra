import type {
  OrchestrationLatestTurn,
  OrchestrationPendingInteraction,
  TurnId,
} from "@penkra/contracts";

/** An assistant completion is provisional until the owning provider session settles. */
export function shouldInterruptProvisionalCompletion(input: {
  readonly previousSession: {
    readonly status: string;
    readonly activeTurnId?: string | null | undefined;
  } | null;
  readonly nextSession: {
    readonly status: string;
    readonly activeTurnId?: string | null | undefined;
  };
  readonly turn: {
    readonly turnId: string;
    readonly providerTurnId?: string | null | undefined;
    readonly state: string;
  } | null;
}): boolean {
  const { previousSession, nextSession, turn } = input;
  return (
    turn?.state === "completed" &&
    (previousSession?.status === "running" || previousSession?.status === "starting") &&
    previousSession.activeTurnId != null &&
    (turn.turnId === previousSession.activeTurnId ||
      turn.providerTurnId === previousSession.activeTurnId) &&
    (nextSession.status === "interrupted" || nextSession.status === "stopped") &&
    nextSession.activeTurnId == null
  );
}

/** The projection conditions shared by command admission and the composer. */
export function canContinueLatestTurn(
  thread: {
    readonly latestTurn: OrchestrationLatestTurn | null;
    readonly session: {
      readonly status: string;
      readonly activeTurnId?: TurnId | null | undefined;
    } | null;
    readonly queuedMessageIds?: ReadonlyArray<unknown> | undefined;
    readonly pendingTurnStartMessageId?: unknown;
    readonly pendingInteractions?: ReadonlyArray<OrchestrationPendingInteraction> | undefined;
    readonly hasPendingApprovals?: boolean | undefined;
    readonly hasPendingUserInput?: boolean | undefined;
    readonly archivedAt?: string | null | undefined;
    readonly deletedAt?: string | null | undefined;
  },
  turnId: TurnId,
): boolean {
  const turn = thread.latestTurn;
  return (
    thread.deletedAt == null &&
    thread.archivedAt == null &&
    turn?.turnId === turnId &&
    (turn.state === "interrupted" || turn.state === "error") &&
    thread.session?.status !== "starting" &&
    thread.session?.status !== "running" &&
    (thread.session?.status === "error" || thread.session?.activeTurnId == null) &&
    thread.pendingTurnStartMessageId == null &&
    !thread.hasPendingApprovals &&
    !thread.hasPendingUserInput &&
    !thread.pendingInteractions?.some((interaction) => interaction.resolvedAt === null)
  );
}
