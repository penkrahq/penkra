import { ContainerId, ThreadId, TurnId } from "@penkra/contracts";
import { describe, expect, it } from "vitest";

import type { AppState } from "../storeState";
import type { SidebarThreadSummary } from "../types";
import { hasActiveThreadExecution } from "./activeWorkPower";

function stateWithThread(
  overrides: Partial<SidebarThreadSummary>,
): Pick<AppState, "threadIds" | "sidebarThreadSummaryById"> {
  const thread = {
    id: ThreadId.makeUnsafe("thread-1"),
    projectId: ContainerId.makeUnsafe("project-1"),
    title: "Thread",
    modelSelection: { provider: "codex", model: "gpt-5" },
    session: null,
    createdAt: "2026-08-09T00:00:00.000Z",
    latestTurn: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  } as SidebarThreadSummary;
  return {
    threadIds: [thread.id],
    sidebarThreadSummaryById: { [thread.id]: thread },
  };
}

describe("hasActiveThreadExecution", () => {
  it.each(["starting", "running"] as const)(
    "keeps the display awake for a %s orchestration session",
    (orchestrationStatus) => {
      const state = stateWithThread({
        session: {
          provider: "codex",
          status: "ready",
          createdAt: "2026-08-09T00:00:00.000Z",
          updatedAt: "2026-08-09T00:00:00.000Z",
          orchestrationStatus,
        },
      });

      expect(hasActiveThreadExecution(state)).toBe(true);
    },
  );

  it("recognizes an executing latest turn when the session projection lags", () => {
    const state = stateWithThread({
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-1"),
        state: "running",
        requestedAt: "2026-08-09T00:00:00.000Z",
        startedAt: "2026-08-09T00:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    });

    expect(hasActiveThreadExecution(state)).toBe(true);
  });

  it.each([
    { hasPendingApprovals: true },
    { hasPendingUserInput: true },
    { archivedAt: "2026-08-09T00:01:00.000Z" },
  ])("does not hold the display for non-executing attention states", (overrides) => {
    const state = stateWithThread({
      session: {
        provider: "codex",
        status: "ready",
        createdAt: "2026-08-09T00:00:00.000Z",
        updatedAt: "2026-08-09T00:00:00.000Z",
        orchestrationStatus: "running",
      },
      ...overrides,
    });

    expect(hasActiveThreadExecution(state)).toBe(false);
  });

  it("returns false when every known thread is idle", () => {
    expect(hasActiveThreadExecution(stateWithThread({}))).toBe(false);
  });
});
