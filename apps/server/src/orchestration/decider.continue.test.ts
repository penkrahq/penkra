import {
  CommandId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
  type OrchestrationCommand,
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
    modelSelection: { provider: "codex", model: "gpt-6-sol" },
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
    ["pending question", () => threadWith({ hasPendingUserInput: true }), turnId],
    ["deleted thread", () => threadWith({ deletedAt: now }), turnId],
    [
      "completed turn",
      () => threadWith({ latestTurn: { ...threadWith().latestTurn, state: "completed" } }),
      turnId,
    ],
  ] as const)("rejects a %s", async (_name, makeThread, expectedTurnId) => {
    await expect(Effect.runPromise(play(makeThread(), expectedTurnId))).rejects.toMatchObject({
      code: "THREAD_CONTINUE_STALE",
    });
  });
});

describe("archived thread admission", () => {
  const decide = (thread: OrchestrationThread, command: OrchestrationCommand) =>
    Effect.runPromise(
      decideOrchestrationCommand({
        readModel: { ...createEmptyReadModel(now), threads: [thread] },
        command,
      }),
    );
  const base = { commandId: CommandId.makeUnsafe("guard-command"), threadId };
  const start = (dispatchMode: "queue" | "steer") => ({
    type: "thread.turn.start" as const,
    ...base,
    message: {
      messageId: MessageId.makeUnsafe("new-message"),
      role: "user" as const,
      text: "Continue",
      attachments: [],
    },
    dispatchMode,
    runtimeMode: "full-access" as const,
    createdAt: now,
  });

  it.each(["queue", "steer"] as const)("refuses %s starts on an archived thread", async (mode) => {
    await expect(decide(threadWith({ archivedAt: now }), start(mode))).rejects.toMatchObject({
      code: "thread_archived",
      detail: "This thread is archived. Unarchive it to send messages.",
    });
  });

  it.each(["play", "restart"] as const)(
    "refuses %s recovery on an archived thread",
    async (reason) => {
      const command: OrchestrationCommand = {
        type: "thread.turn.recover",
        ...base,
        reason,
        turnId,
        interruptedTurnId: turnId,
        recoveryMessageId: MessageId.makeUnsafe("recovery-message"),
        connectionId: null,
        bindingRevision: 0,
        createdAt: now,
      };
      await expect(decide(threadWith({ archivedAt: now }), command)).rejects.toMatchObject({
        code: "thread_archived",
        detail: "This thread is archived. Unarchive it to send messages.",
      });
    },
  );

  it("refuses queue promotion on an archived thread", async () => {
    await expect(
      decide(threadWith({ archivedAt: now }), {
        type: "thread.turn.dispatch-queued",
        ...base,
        turnId,
        messageId: MessageId.makeUnsafe("queued-message"),
        runtimeMode: "full-access",
        createdAt: now,
      }),
    ).rejects.toMatchObject({ code: "thread_archived" });
  });

  it.each(["thread.message.edit-and-resend", "thread.conversation.rollback"] as const)(
    "refuses %s before emitting a transcript event",
    async (type) => {
      const command = {
        type,
        ...base,
        messageId: MessageId.makeUnsafe("previous-message"),
        numTurns: 1,
        text: "edited",
        runtimeMode: "full-access",
        connectionId: null,
        bindingRevision: 0,
        createdAt: now,
      } as unknown as OrchestrationCommand;
      await expect(decide(threadWith({ archivedAt: now }), command)).rejects.toMatchObject({
        code: "thread_archived",
        detail: "This thread is archived. Unarchive it to send messages.",
      });
    },
  );

  it.each([
    "thread.update",
    "thread.pinned-message.add",
    "thread.pinned-message.remove",
    "thread.pinned-message.done.set",
    "thread.pinned-message.label.set",
    "thread.runtime-mode.set",
    "thread.turn.steer-queued",
    "thread.task.background",
    "thread.approval.respond",
    "thread.user-input.respond",
    "thread.messages.import",
    "thread.message.assistant.delta",
    "thread.message.assistant.complete",
    "thread.conversation.rollback.complete",
    "thread.message.delivery.set",
    "thread.activity.append",
    "thread.activity-read-model.touch",
  ] as const)("refuses other archived thread mutation: %s", async (type) => {
    const command = {
      type,
      ...base,
      title: "Changed",
      messageId: MessageId.makeUnsafe("previous-message"),
      messages: [],
      createdAt: now,
    } as unknown as OrchestrationCommand;
    await expect(decide(threadWith({ archivedAt: now }), command)).rejects.toMatchObject({
      code: "thread_archived",
    });
  });

  it.each([
    ["running latest turn", { latestTurn: { ...threadWith().latestTurn, state: "running" } }],
    ["pending start", { pendingTurnStartMessageId: MessageId.makeUnsafe("pending") }],
    ["starting session", { session: { status: "starting", activeTurnId: null } }],
    ["active provider turn", { session: { status: "running", activeTurnId: turnId } }],
  ])("refuses archive with %s", async (_reason, changes) => {
    await expect(
      decide(threadWith(changes), { type: "thread.archive", ...base }),
    ).rejects.toMatchObject({
      code: "thread_running",
      detail: "This thread is still running. Stop it before archiving.",
    });
  });

  it("drops queued messages in the archive command", async () => {
    const queuedMessageId = MessageId.makeUnsafe("queued-message");
    const result = await decide(threadWith({ queuedMessageIds: [queuedMessageId] }), {
      type: "thread.archive",
      ...base,
    });
    expect(result).toMatchObject([
      { type: "thread.turn-start-cancelled", payload: { messageId: queuedMessageId } },
      { type: "thread.archived", payload: { threadId } },
    ]);
  });

  it("allows unarchive, delete, and interrupt on an archived thread", async () => {
    for (const command of [
      { type: "thread.unarchive" as const, ...base },
      { type: "thread.delete" as const, ...base },
      { type: "thread.turn.interrupt" as const, ...base, createdAt: now },
    ]) {
      await expect(decide(threadWith({ archivedAt: now }), command)).resolves.toBeDefined();
    }
  });

  it("applies the guard to the target child independently of its parent", async () => {
    const parentId = ThreadId.makeUnsafe("parent-thread");
    const parent = threadWith({ id: parentId, archivedAt: now });
    const child = threadWith({ parentThreadId: parentId });
    const readModel = { ...createEmptyReadModel(now), threads: [parent, child] };
    await expect(
      Effect.runPromise(decideOrchestrationCommand({ readModel, command: start("queue") })),
    ).resolves.toBeDefined();
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          readModel,
          command: {
            type: "thread.archive",
            ...base,
          },
        }),
      ),
    ).resolves.toMatchObject({ type: "thread.archived" });
  });
});
