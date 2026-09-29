import type { OrchestrationCommand } from "@penkra/contracts";
import { describe, expect, it } from "vitest";

import { qaAcceptedCommandAction, qaCommandCheckpoint } from "./qaCommandCheckpoints";

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
});
