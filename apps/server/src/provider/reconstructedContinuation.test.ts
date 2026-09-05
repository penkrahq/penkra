import { describe, expect, it } from "vitest";
import {
  EventId,
  MessageId,
  TurnId,
  type OrchestrationMessage,
  type OrchestrationThreadActivity,
} from "@penkra/contracts";

import {
  formatReconstructedContinuation,
  selectReconstructedContinuation,
} from "./reconstructedContinuation.ts";

const message = (
  id: string,
  turnId: string,
  sequence: number,
  text = id,
): OrchestrationMessage => ({
  id: MessageId.makeUnsafe(id),
  role: sequence % 2 === 0 ? "assistant" : "user",
  text,
  turnId: TurnId.makeUnsafe(turnId),
  streaming: false,
  source: "native",
  sequence,
  createdAt: `2026-09-01T00:00:${String(sequence).padStart(2, "0")}.000Z`,
  updatedAt: `2026-09-01T00:00:${String(sequence).padStart(2, "0")}.000Z`,
});

const compaction = (sequence: number, turnId: string): OrchestrationThreadActivity => ({
  id: EventId.makeUnsafe(`compact-${sequence}`),
  tone: "info",
  kind: "context-compaction",
  summary: "Context compacted automatically",
  payload: { trigger: "auto" },
  turnId: TurnId.makeUnsafe(turnId),
  sequence,
  createdAt: `2026-09-01T00:00:${String(sequence).padStart(2, "0")}.000Z`,
});

describe("reconstructed continuation", () => {
  it("replays from the first turn after the latest completed compaction", () => {
    const selected = selectReconstructedContinuation({
      messages: [
        message("before", "turn-1", 1),
        message("same-turn", "turn-compact-new", 8),
        message("after", "turn-3", 9),
        message("current", "turn-4", 10),
      ],
      activities: [compaction(2, "turn-compact-old"), compaction(7, "turn-compact-new")],
      currentMessageId: "current",
    });

    expect(selected.boundary).toEqual({
      kind: "compaction",
      activityId: "compact-7",
      turnId: "turn-compact-new",
    });
    expect(selected.messages.map((entry) => entry.id)).toEqual(["after"]);
  });

  it("replays from the first message when there is no compaction", () => {
    const selected = selectReconstructedContinuation({
      messages: [message("second", "turn-2", 2), message("first", "turn-1", 1)],
      activities: [],
      currentMessageId: "not-present",
    });
    expect(selected.boundary).toEqual({ kind: "thread-start" });
    expect(selected.messages.map((entry) => entry.id)).toEqual(["first", "second"]);
  });

  it("keeps retained text exact and tells the agent how to retrieve older context", () => {
    const continuation = selectReconstructedContinuation({
      messages: [message("first", "turn-1", 1, "Exact retained text")],
      activities: [],
      currentMessageId: "current",
    });
    const prompt = formatReconstructedContinuation({
      threadId: "thread-1",
      continuation,
      currentInput: "Continue the plan",
    });
    expect(prompt).toContain("Exact retained text");
    expect(prompt).toContain("penkra threads read --thread-id thread-1");
    expect(prompt).toContain("do not ask the person to repeat");
    expect(prompt).toContain("<new-user-message>\n\nContinue the plan");
  });
});
