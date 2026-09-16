import { FolderId, ThreadDeckId, ThreadId, TurnId } from "@penkra/contracts";
import { describe, expect, it } from "vitest";

import type { SidebarThreadSummary } from "../types";
import { deriveUnmountedThreadLiveState } from "./desktopThreadState";

function thread(overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: ThreadId.makeUnsafe("thread-background"),
    deckId: ThreadDeckId.makeUnsafe("deck-background"),
    deckSortOrder: 0,
    folderId: FolderId.makeUnsafe("folder-1"),
    title: "Background thread",
    modelSelection: { provider: "codex", model: "gpt-5.5" },
    session: null,
    createdAt: "2026-09-14T00:00:00.000Z",
    latestTurn: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  };
}

describe("deriveUnmountedThreadLiveState", () => {
  it("reads a background running thread without a mounted ChatView", () => {
    expect(
      deriveUnmountedThreadLiveState(
        "thread-background",
        thread({
          session: {
            provider: "claudeAgent",
            status: "running",
            activeTurnId: TurnId.makeUnsafe("turn-live"),
            createdAt: "2026-09-14T00:00:00.000Z",
            updatedAt: "2026-09-14T00:01:00.000Z",
            orchestrationStatus: "running",
          },
        }),
        2,
      ),
    ).toEqual({
      threadId: "thread-background",
      phase: "running",
      activeTurnId: "turn-live",
      queuedCount: 2,
      pendingUserInput: false,
      sendBusy: true,
      steeringPending: false,
    });
  });

  it("reports a background question as waiting rather than active work", () => {
    const result = deriveUnmountedThreadLiveState(
      "thread-background",
      thread({
        hasPendingUserInput: true,
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-question"),
          state: "running",
          requestedAt: "2026-09-14T00:00:00.000Z",
          startedAt: "2026-09-14T00:00:01.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      }),
      0,
    );

    expect(result.phase).toBe("waiting");
    expect(result.pendingUserInput).toBe(true);
  });

  it("does not report an older running-turn projection after the session settled", () => {
    const result = deriveUnmountedThreadLiveState(
      "thread-background",
      thread({
        session: {
          provider: "opencode",
          status: "ready",
          createdAt: "2026-09-14T00:00:00.000Z",
          updatedAt: "2026-09-14T00:02:00.000Z",
          orchestrationStatus: "interrupted",
        },
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-stale"),
          state: "running",
          requestedAt: "2026-09-14T00:00:00.000Z",
          startedAt: "2026-09-14T00:01:00.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      }),
      0,
    );

    expect(result.phase).toBe("idle");
    expect(result.activeTurnId).toBeNull();
    expect(result.sendBusy).toBe(false);
  });

  it("reports a newer running turn instead of a stale errored session pointer", () => {
    const result = deriveUnmountedThreadLiveState(
      "thread-background",
      thread({
        session: {
          provider: "codex",
          status: "error",
          activeTurnId: TurnId.makeUnsafe("turn-failed"),
          createdAt: "2026-09-14T00:00:00.000Z",
          updatedAt: "2026-09-14T00:01:00.000Z",
          orchestrationStatus: "error",
        },
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-new"),
          state: "running",
          requestedAt: "2026-09-14T00:02:00.000Z",
          startedAt: "2026-09-14T00:02:01.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      }),
      0,
    );

    expect(result.phase).toBe("running");
    expect(result.activeTurnId).toBe("turn-new");
  });

  it("distinguishes a deleted thread from an unmounted one", () => {
    expect(() => deriveUnmountedThreadLiveState("missing", undefined, 0)).toThrow(
      "no longer exists",
    );
  });
});
