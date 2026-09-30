import type { OrchestrationCommand } from "@penkra/contracts";
import { describe, expect, it } from "vitest";

import {
  qaAcceptedCommandAction,
  qaCommandCheckpoint,
  qaRuntimeActionForCommand,
} from "./qaCommandCheckpoints";

const command = (type: OrchestrationCommand["type"], reason?: "play") =>
  ({ type, reason }) as OrchestrationCommand;

describe("QA command checkpoints", () => {
  it("marks admitted send, create, and archive after the command is persisted", () => {
    expect(qaCommandCheckpoint(command("thread.turn.start"), "dispatch")).toEqual({
      flow: "send",
      step: "send.dispatched",
    });
    expect(qaCommandCheckpoint(command("thread.turn.start"), "accepted")).toEqual({
      flow: "send",
      step: "send.accepted",
    });
    expect(qaCommandCheckpoint(command("thread.create"), "accepted")).toEqual({
      flow: "thread_create",
      step: "thread.created",
    });
    expect(qaCommandCheckpoint(command("thread.archive"), "accepted")).toEqual({
      flow: "archive",
      step: "thread.archived",
    });
  });

  it("does not claim stop or play completed when only their command was sent", () => {
    expect(qaCommandCheckpoint(command("thread.turn.interrupt"), "dispatch")).toEqual({
      flow: "stop",
      step: "stop.requested",
    });
    expect(qaCommandCheckpoint(command("thread.turn.interrupt"), "accepted")).toBeNull();
    expect(qaCommandCheckpoint(command("thread.turn.recover", "play"), "dispatch")).toEqual({
      flow: "play",
      step: "play.requested",
    });
    expect(qaCommandCheckpoint(command("thread.turn.recover", "play"), "accepted")).toBeNull();
  });

  it("signs only persisted command actions with an independent result", () => {
    expect(qaAcceptedCommandAction(command("thread.turn.start"))).toBe("send");
    expect(qaAcceptedCommandAction(command("thread.create"))).toBe("thread-create");
    expect(qaAcceptedCommandAction(command("thread.archive"))).toBe("archive");
    expect(qaAcceptedCommandAction(command("thread.turn.interrupt"))).toBeNull();
    expect(qaAcceptedCommandAction(command("thread.turn.recover", "play"))).toBeNull();
  });

  it("arms runtime proofs for stop, play, and queued sends", () => {
    expect(
      qaRuntimeActionForCommand({
        type: "thread.turn.interrupt",
        threadId: "thread-a",
        turnId: "turn-a",
      } as OrchestrationCommand),
    ).toEqual({ flow: "stop", threadId: "thread-a", turnId: "turn-a" });
    expect(
      qaRuntimeActionForCommand({
        type: "thread.turn.recover",
        reason: "play",
        threadId: "thread-a",
        turnId: "turn-a",
      } as OrchestrationCommand),
    ).toEqual({ flow: "play", threadId: "thread-a", turnId: "turn-a" });
    expect(
      qaRuntimeActionForCommand({
        type: "thread.turn.start",
        dispatchMode: "queue",
        threadId: "thread-a",
        commandId: "command-a",
      } as OrchestrationCommand),
    ).toEqual({ flow: "queue", threadId: "thread-a", turnId: "turn:command-a" });
    expect(
      qaRuntimeActionForCommand({
        type: "thread.turn.interrupt",
        threadId: "thread-a",
      } as OrchestrationCommand),
    ).toBeNull();
  });
});
