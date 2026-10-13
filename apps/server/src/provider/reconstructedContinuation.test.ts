import { describe, expect, it } from "vitest";
import { ThreadId, TurnId } from "@penkra/contracts";
import type { ThreadItemRecord } from "../cleanCore/threadItemsPage.ts";

import {
  formatReconstructedContinuation,
  selectReconstructedContinuation,
} from "./reconstructedContinuation.ts";

const message = (id: string, turnId: string, sequence: number, text = id): ThreadItemRecord => ({
  threadId: ThreadId.makeUnsafe("thread-1"),
  sourceId: id,
  kind: sequence % 2 === 0 ? "text" : "user",
  status: sequence % 2 === 0 ? "done" : "sent",
  text,
  data: sequence % 2 === 0 ? null : JSON.stringify({ origin: { _tag: "user" }, attachments: [] }),
  turnId: TurnId.makeUnsafe(turnId),
  seq: sequence,
  createdAt: `2026-09-01T00:00:${String(sequence).padStart(2, "0")}.000Z`,
  updatedAt: `2026-09-01T00:00:${String(sequence).padStart(2, "0")}.000Z`,
});

const compaction = (sequence: number, turnId: string): ThreadItemRecord => ({
  ...message(`compact-${sequence}`, turnId, sequence),
  kind: "notice",
  status: "done",
  text: "Context compacted automatically",
  data: JSON.stringify({
    kind: "context-compaction",
    tone: "info",
    summary: "Context compacted automatically",
    payload: { trigger: "auto" },
  }),
});

describe("reconstructed continuation", () => {
  it("replays from the first turn after the latest completed compaction", () => {
    const selected = selectReconstructedContinuation({
      items: [
        message("before", "turn-1", 1),
        message("same-turn", "turn-compact-new", 8),
        message("after", "turn-3", 9),
        message("current", "turn-4", 10),
        compaction(2, "turn-compact-old"),
        compaction(7, "turn-compact-new"),
      ],
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
      items: [message("second", "turn-2", 2), message("first", "turn-1", 1)],
      currentMessageId: "not-present",
    });
    expect(selected.boundary).toEqual({ kind: "thread-start" });
    expect(selected.messages.map((entry) => entry.id)).toEqual(["first", "second"]);
  });

  it("keeps retained text exact and tells the agent how to retrieve older context", () => {
    const continuation = selectReconstructedContinuation({
      items: [message("first", "turn-1", 1, "Exact retained text")],
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
