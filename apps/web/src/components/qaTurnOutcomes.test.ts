import { describe, expect, it } from "vitest";
import { matchesPromotedQueuedMessage, matchesRequestedTurnOutcome } from "./qaTurnOutcomes";

describe("QA stop and play outcome correlation", () => {
  it("does not accept another turn on the same thread", () => {
    const base = {
      requestedThreadId: "thread-a",
      requestedTurnId: "turn-target",
      activeThreadId: "thread-a",
      activeTurnId: "turn-other",
    };
    expect(
      matchesRequestedTurnOutcome({
        ...base,
        actualState: "interrupted",
        expectedState: "interrupted",
      }),
    ).toBe(false);
    expect(
      matchesRequestedTurnOutcome({
        ...base,
        actualState: "running",
        expectedState: "running",
      }),
    ).toBe(false);
  });

  it("accepts the requested turn only in its expected state", () => {
    const base = {
      requestedThreadId: "thread-a",
      requestedTurnId: "turn-target",
      activeThreadId: "thread-a",
      activeTurnId: "turn-target",
    };
    expect(
      matchesRequestedTurnOutcome({
        ...base,
        actualState: "interrupted",
        expectedState: "interrupted",
      }),
    ).toBe(true);
    expect(
      matchesRequestedTurnOutcome({ ...base, actualState: "ready", expectedState: "running" }),
    ).toBe(false);
    expect(
      matchesRequestedTurnOutcome({ ...base, actualState: "running", expectedState: "running" }),
    ).toBe(true);
  });
});

describe("QA queued send correlation", () => {
  it("does not claim promotion after cancel followed by an unrelated turn", () => {
    const queued = {
      startCommandId: "command-queued",
      messageId: "message-queued",
      queuedMessageIds: [],
      seenQueued: true,
      latestTurnState: "running",
    };
    expect(matchesPromotedQueuedMessage({ ...queued, latestTurnId: "turn:command-other" })).toBe(
      false,
    );
    expect(
      matchesPromotedQueuedMessage({
        ...queued,
        queuedMessageIds: ["message-queued"],
        latestTurnId: "turn:command-queued",
      }),
    ).toBe(false);
    expect(matchesPromotedQueuedMessage({ ...queued, latestTurnId: "turn:command-queued" })).toBe(
      true,
    );
  });
});
