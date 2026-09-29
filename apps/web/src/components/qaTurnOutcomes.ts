export function matchesRequestedTurnOutcome(input: {
  readonly requestedThreadId: string;
  readonly requestedTurnId: string;
  readonly activeThreadId: string | null;
  readonly activeTurnId: string | null;
  readonly actualState: string | null;
  readonly expectedState: "interrupted" | "running";
}): boolean {
  return (
    input.activeThreadId === input.requestedThreadId &&
    input.activeTurnId === input.requestedTurnId &&
    input.actualState === input.expectedState
  );
}

/** The projection owns turn IDs as `turn:<start command ID>`. The command also owns the queued message. */
export function matchesPromotedQueuedMessage(input: {
  readonly startCommandId: string;
  readonly messageId: string;
  readonly queuedMessageIds: readonly string[];
  readonly seenQueued: boolean;
  readonly latestTurnId: string | null;
  readonly latestTurnState: string | null;
}): boolean {
  return (
    input.seenQueued &&
    !input.queuedMessageIds.includes(input.messageId) &&
    input.latestTurnId === `turn:${input.startCommandId}` &&
    input.latestTurnState === "running"
  );
}
