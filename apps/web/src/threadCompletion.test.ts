import { TurnId } from "@penkra/contracts";
import { describe, expect, it } from "vitest";

import { getThreadCompletionKey, hasUnseenThreadCompletion } from "./threadCompletion";

const latestTurn = {
  turnId: TurnId.makeUnsafe("turn-completed"),
  completedAt: "2026-08-20T12:07:54.332Z",
} as const;

describe("thread completion notifications", () => {
  it("uses the exact turn identity and completion timestamp as its dismissal key", () => {
    expect(getThreadCompletionKey(latestTurn)).toBe(
      "Completed:turn-completed:2026-08-20T12:07:54.332Z",
    );
  });

  it("treats a completion as seen once the thread was visited at or after it", () => {
    expect(
      hasUnseenThreadCompletion({
        latestTurn,
        lastVisitedAt: latestTurn.completedAt,
      }),
    ).toBe(false);
    expect(
      hasUnseenThreadCompletion({
        latestTurn,
        lastVisitedAt: "2026-08-20T12:07:55.000Z",
      }),
    ).toBe(false);
  });

  it("does not require provider start timing to acknowledge a projected completion", () => {
    expect(
      hasUnseenThreadCompletion({
        latestTurn,
        lastVisitedAt: "2026-08-20T12:07:53.000Z",
      }),
    ).toBe(true);
  });

  it("fails closed for invalid completion timestamps", () => {
    expect(
      hasUnseenThreadCompletion({
        latestTurn: { ...latestTurn, completedAt: "not-a-timestamp" },
        lastVisitedAt: null,
      }),
    ).toBe(false);
  });
});
