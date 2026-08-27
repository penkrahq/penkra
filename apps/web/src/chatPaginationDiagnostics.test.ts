import type { OrchestrationGetThreadTurnsPageResult } from "@penkra/contracts";
import { describe, expect, it } from "vitest";

import { summarizeThreadTurnsPage } from "./chatPaginationDiagnostics";

describe("chat pagination diagnostics", () => {
  it("summarizes logical conversation pages and visible message roles", () => {
    const page = {
      threadId: "thread-long",
      snapshotSequence: 77,
      conversationTurnCount: 1,
      messages: [
        { role: "user" },
        { role: "assistant" },
        { role: "assistant" },
        { role: "system" },
      ],
      activities: [{ id: "activity-one" }, { id: "activity-unscoped" }],
      pendingInteractions: [],
      hasOlder: true,
      nextCursor: "cursor",
    } as unknown as OrchestrationGetThreadTurnsPageResult;

    expect(summarizeThreadTurnsPage(page)).toEqual({
      conversationTurnCount: 1,
      messageCount: 4,
      userMessageCount: 1,
      assistantMessageCount: 2,
      systemMessageCount: 1,
      activityCount: 2,
      pendingInteractionCount: 0,
      hasOlder: true,
      nextCursorPresent: true,
      snapshotSequence: 77,
    });
  });
});
