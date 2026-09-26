import {
  CommandId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
} from "@penkra/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel } from "./projector.ts";
import { PLAY_TURN_RECOVERY_PROMPT } from "./restartTurnRecovery.ts";

const now = "2026-09-26T00:00:00.000Z";
const threadId = ThreadId.makeUnsafe("continue-thread");
const turnId = TurnId.makeUnsafe("continue-turn");

function threadWith(changes: Record<string, unknown> = {}): OrchestrationThread {
  return {
    id: threadId,
    deletedAt: null,
    archivedAt: null,
    runtimeMode: "full-access",
    latestTurn: {
      turnId,
      state: "interrupted",
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      assistantMessageId: null,
    },
    session: {
      status: "stopped",
      activeTurnId: null,
    },
    queuedMessageIds: [],
    pendingTurnStartMessageId: null,
    pendingInteractions: [],
    ...changes,
  } as unknown as OrchestrationThread;
}

function play(thread: OrchestrationThread, expectedTurnId = turnId) {
  return decideOrchestrationCommand({
    readModel: { ...createEmptyReadModel(now), threads: [thread] },
    command: {
      type: "thread.turn.recover",
      reason: "play",
      commandId: CommandId.makeUnsafe("continue-command"),
      threadId,
      turnId: expectedTurnId,
      interruptedTurnId: expectedTurnId,
      recoveryMessageId: MessageId.makeUnsafe("invisible-continue-message"),
      connectionId: null,
      bindingRevision: 0,
      createdAt: now,
    },
  });
}

describe("Play continuation admission", () => {
  it("uses the exact Play continuation instruction", () => {
    expect(PLAY_TURN_RECOVERY_PROMPT).toBe(
      "The previous turn did not finish. Continue the existing task from the current state. Verify the current state before repeating any action whose outcome may be uncertain.",
    );
  });
  it.each(["interrupted", "error"] as const)(
    "accepts a %s latest turn without a user message",
    async (state) => {
      const thread = threadWith({
        latestTurn: { ...threadWith().latestTurn, state },
      });
      const event = await Effect.runPromise(play(thread));
      expect(event).toMatchObject({
        type: "thread.turn-start-requested",
        payload: {
          turnId,
          recoveryOfTurnId: turnId,
          recoveryReason: "play",
          restartRecovery: true,
        },
      });
      expect(Array.isArray(event)).toBe(false);
    },
  );

  it("allows a child thread whose latest turn is unfinished", async () => {
    const event = await Effect.runPromise(
      play(threadWith({ parentThreadId: ThreadId.makeUnsafe("parent-thread") })),
    );
    expect(event).toMatchObject({ type: "thread.turn-start-requested" });
  });

  it.each([
    ["stale turn", () => threadWith(), TurnId.makeUnsafe("stale-turn")],
    [
      "running turn",
      () => threadWith({ session: { status: "running", activeTurnId: turnId } }),
      turnId,
    ],
    [
      "queued message",
      () => threadWith({ queuedMessageIds: [MessageId.makeUnsafe("queued")] }),
      turnId,
    ],
    ["pending approval", () => threadWith({ hasPendingApprovals: true }), turnId],
    ["pending question", () => threadWith({ hasPendingUserInput: true }), turnId],
    ["archived thread", () => threadWith({ archivedAt: now }), turnId],
    ["deleted thread", () => threadWith({ deletedAt: now }), turnId],
    [
      "completed turn",
      () => threadWith({ latestTurn: { ...threadWith().latestTurn, state: "completed" } }),
      turnId,
    ],
  ] as const)("rejects a %s", async (_name, makeThread, expectedTurnId) => {
    await expect(Effect.runPromise(play(makeThread(), expectedTurnId))).rejects.toThrow(
      "continue-thread-changed",
    );
  });
});
