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
