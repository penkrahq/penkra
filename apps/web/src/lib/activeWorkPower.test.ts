import { FolderId, ThreadId, TurnId } from "@penkra/contracts";
import { describe, expect, it } from "vitest";

import type { AppState } from "../storeState";
import type { SidebarThreadSummary } from "../types";
import { hasActiveThreadExecution } from "./activeWorkPower";

function stateWithThread(
  overrides: Partial<SidebarThreadSummary>,
): Pick<AppState, "threadIds" | "sidebarThreadSummaryById"> {
  const thread = {
    id: ThreadId.makeUnsafe("thread-1"),
    folderId: FolderId.makeUnsafe("project-1"),
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
  it.each(["codex", "claudeAgent", "opencode"] as const)(
    "uses the same active-session policy for %s",
    (provider) => {
      const state = stateWithThread({
        modelSelection: { provider, model: "test-model" },
        session: {
          provider,
          status: "running",
          createdAt: "2026-08-09T00:00:00.000Z",
          updatedAt: "2026-08-09T00:00:01.000Z",
          orchestrationStatus: "running",
        },
      });

      expect(hasActiveThreadExecution(state)).toBe(true);
    },
  );

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

  it("does not keep the display awake for a stale running turn after its session settled", () => {
    const state = stateWithThread({
      session: {
        provider: "codex",
        status: "ready",
        createdAt: "2026-08-09T00:00:00.000Z",
        updatedAt: "2026-08-09T00:02:00.000Z",
        orchestrationStatus: "interrupted",
      },
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-stale"),
        state: "running",
        requestedAt: "2026-08-09T00:00:00.000Z",
        startedAt: "2026-08-09T00:01:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    });

    expect(hasActiveThreadExecution(state)).toBe(false);
  });

  it("keeps the display awake when a running turn is newer than the last settled session", () => {
    const state = stateWithThread({
      session: {
        provider: "opencode",
        status: "ready",
        createdAt: "2026-08-09T00:00:00.000Z",
        updatedAt: "2026-08-09T00:01:00.000Z",
        orchestrationStatus: "idle",
      },
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-new"),
        state: "running",
        requestedAt: "2026-08-09T00:02:00.000Z",
        startedAt: "2026-08-09T00:02:01.000Z",
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

  it("keeps one app-wide assertion when any thread remains active", () => {
    const idle = stateWithThread({}).sidebarThreadSummaryById["thread-1"]!;
    const activeId = ThreadId.makeUnsafe("thread-2");
    const active = {
      ...idle,
      id: activeId,
      session: {
        provider: "claudeAgent" as const,
        status: "running" as const,
        createdAt: "2026-08-09T00:00:00.000Z",
        updatedAt: "2026-08-09T00:01:00.000Z",
        orchestrationStatus: "running" as const,
      },
    };

    expect(
      hasActiveThreadExecution({
        threadIds: [idle.id, activeId],
        sidebarThreadSummaryById: { [idle.id]: idle, [activeId]: active },
      }),
    ).toBe(true);
  });
});
