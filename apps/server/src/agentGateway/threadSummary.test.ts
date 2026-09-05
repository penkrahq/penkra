import { assert, describe, it } from "@effect/vitest";
import type { OrchestrationMessage, OrchestrationThreadActivity } from "@penkra/contracts";
import { EventId, MessageId, ThreadId, TurnId } from "@penkra/contracts";

import {
  deriveAgentThreadStatus,
  packAgentTranscriptPage,
  paginateThreadMessages,
  resolveActiveTurn,
} from "./threadSummary.ts";

function makeActivity(
  id: string,
  kind: string,
  sequence: number,
  payload: OrchestrationThreadActivity["payload"] = { ok: true },
): OrchestrationThreadActivity {
  return {
    id: EventId.makeUnsafe(id),
    tone: kind.startsWith("tool.") ? "tool" : "info",
    kind,
    summary: `${kind} summary`,
    payload,
    turnId: TurnId.makeUnsafe("turn-activity"),
    sequence,
    createdAt: `2026-03-01T00:00:${String(sequence).padStart(2, "0")}.000Z`,
  };
}

function makeMessage(index: number, text = `message ${index}`): OrchestrationMessage {
  return {
    id: MessageId.makeUnsafe(`m-${index}`),
    role: index % 2 === 0 ? "user" : "assistant",
    text,
    turnId: null,
    streaming: false,
    source: "native",
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
  };
}

const session = (
  status: "running" | "ready" | "error" | "starting" | "stopped",
  activeTurnId: string | null = null,
) => ({
  threadId: ThreadId.makeUnsafe("t-1"),
  status,
  providerName: null,
  runtimeMode: "approval-required" as const,
  activeTurnId: activeTurnId === null ? null : TurnId.makeUnsafe(activeTurnId),
  lastError: null,
  updatedAt: "2026-03-01T00:00:00.000Z",
});

const latestTurn = (
  state: "queued" | "running" | "completed" | "interrupted" | "error" | "cancelled",
) => ({
  turnId: TurnId.makeUnsafe("turn-1"),
  state,
  requestedAt: "2026-03-01T00:00:00.000Z",
  startedAt: null,
  completedAt: null,
  assistantMessageId: null,
});

describe("deriveAgentThreadStatus", () => {
  it("prioritizes pending approval over a running turn", () => {
    assert.equal(
      deriveAgentThreadStatus({
        session: session("running"),
        latestTurn: latestTurn("running"),
        hasPendingApprovals: true,
      }),
      "waiting-for-approval",
    );
  });

  it("reports pending user input", () => {
    assert.equal(
      deriveAgentThreadStatus({
        session: session("ready"),
        latestTurn: latestTurn("completed"),
        hasPendingUserInput: true,
      }),
      "waiting-for-user-input",
    );
  });

  it("reports working while a turn runs", () => {
    assert.equal(
      deriveAgentThreadStatus({ session: session("running"), latestTurn: latestTurn("running") }),
      "working",
    );
  });

  it("reports working while an admitted turn waits in the durable queue", () => {
    assert.equal(
      deriveAgentThreadStatus({ session: session("ready"), latestTurn: latestTurn("queued") }),
      "working",
    );
  });

  it("reports error, interrupted, and idle states", () => {
    assert.equal(
      deriveAgentThreadStatus({ session: session("error"), latestTurn: latestTurn("completed") }),
      "error",
    );
    assert.equal(
      deriveAgentThreadStatus({ session: session("ready"), latestTurn: latestTurn("interrupted") }),
      "interrupted",
    );
    assert.equal(
      deriveAgentThreadStatus({ session: session("ready"), latestTurn: latestTurn("completed") }),
      "idle",
    );
    assert.equal(deriveAgentThreadStatus({ session: null, latestTurn: null }), "idle");
  });
});

describe("resolveActiveTurn", () => {
  it("requires the running session to match the canonical or provider turn id", () => {
    const runningTurn = {
      ...latestTurn("running"),
      turnId: TurnId.makeUnsafe("canonical-turn"),
      providerTurnId: TurnId.makeUnsafe("provider-turn"),
    };

    assert.strictEqual(
      resolveActiveTurn({
        session: session("running", "provider-turn"),
        latestTurn: runningTurn,
      }),
      runningTurn,
    );
    assert.isNull(
      resolveActiveTurn({
        session: session("running", "different-provider-turn"),
        latestTurn: runningTurn,
      }),
    );
    assert.isNull(
      resolveActiveTurn({
        session: session("ready"),
        latestTurn: runningTurn,
      }),
    );
  });
});

describe("paginateThreadMessages", () => {
  it("returns the newest messages first call and pages older ones via cursor", () => {
    const messages = Array.from({ length: 45 }, (_, index) => makeMessage(index));
    const firstPage = paginateThreadMessages({ messages, messageLimit: 20 });
    assert.equal(firstPage.totalMessages, 45);
    assert.equal(firstPage.messages.length, 20);
    assert.equal(firstPage.messages[0]?.index, 25);
    assert.equal(firstPage.messages.at(-1)?.index, 44);
    assert.equal(firstPage.nextCursor, "25");

    const secondPage = paginateThreadMessages({
      messages,
      messageLimit: 20,
      cursor: firstPage.nextCursor,
    });
    assert.equal(secondPage.messages[0]?.index, 5);
    assert.equal(secondPage.messages.at(-1)?.index, 24);
    assert.equal(secondPage.nextCursor, "5");

    const lastPage = paginateThreadMessages({
      messages,
      messageLimit: 20,
      cursor: secondPage.nextCursor,
    });
    assert.equal(lastPage.messages.length, 5);
    assert.equal(lastPage.messages[0]?.index, 0);
    assert.isUndefined(lastPage.nextCursor);
  });

  it("truncates long messages and marks them", () => {
    const longText = "x".repeat(5000);
    const page = paginateThreadMessages({
      messages: [makeMessage(0, longText)],
      maxMessageChars: 100,
    });
    assert.equal(page.messages[0]?.truncated, true);
    assert.include(page.messages[0]?.text, "[... truncated 4900 chars]");
  });

  it("ignores garbage cursors", () => {
    const messages = Array.from({ length: 3 }, (_, index) => makeMessage(index));
    const page = paginateThreadMessages({ messages, cursor: "banana" });
    assert.equal(page.messages.length, 3);
  });

  it("surfaces dispatch origin on messages that carry it", () => {
    const message = { ...makeMessage(0), dispatchOrigin: "agent" as const };
    const page = paginateThreadMessages({ messages: [message] });
    assert.equal(page.messages[0]?.dispatchOrigin, "agent");
  });
});

describe("packAgentTranscriptPage", () => {
  it("distinguishes a queued user message from one already delivered", () => {
    const queued = {
      ...makeMessage(0, "queued"),
      delivery: { state: "queued" as const, queued: true, sequence: 2 },
    };
    const delivered = {
      ...makeMessage(1, "delivered"),
      delivery: { state: "starting" as const, queued: true, sequence: 3 },
    };
    const page = packAgentTranscriptPage({ messages: [queued, delivered], activities: [] });
    assert.deepEqual(
      page.items.map((item) => (item.type === "message" ? item.delivery : null)),
      ["queued", "delivered"],
    );
  });

  it("continues a long message losslessly without rewriting its text", () => {
    const text = Array.from({ length: 45_514 }, (_, index) => String(index % 10)).join("");
    const message = {
      ...makeMessage(0, text),
      turnId: TurnId.makeUnsafe("turn-long"),
      sequence: 7,
      streaming: true,
      dispatchOrigin: "agent" as const,
    };

    const fragments: string[] = [];
    let anchor: Parameters<typeof packAgentTranscriptPage>[0]["anchor"];
    do {
      const page = packAgentTranscriptPage({
        messages: [message],
        activities: [],
        ...(anchor ? { anchor } : {}),
        textBudget: 10_000,
      });
      assert.equal(page.items.length, 1);
      const item = page.items[0]!;
      assert.equal(item.type, "message");
      if (item.type !== "message") throw new Error("Expected message item.");
      assert.equal(item.messageId, "m-0");
      assert.equal(item.turnId, "turn-long");
      assert.equal(item.sequence, 7);
      assert.equal(item.streaming, true);
      assert.equal(item.dispatchOrigin, "agent");
      assert.notInclude(item.text, "[... truncated");
      fragments.unshift(item.text);
      anchor = page.nextAnchor;
    } while (anchor !== undefined);

    assert.equal(fragments.join(""), text);
  });

  it("returns typed conversational activity in transcript order", () => {
    const before = { ...makeMessage(0, "before"), sequence: 1 };
    const after = { ...makeMessage(1, "after"), sequence: 3 };
    const page = packAgentTranscriptPage({
      messages: [after, before],
      activities: [makeActivity("activity-1", "tool.completed", 2, { output: "done" })],
    });

    assert.deepEqual(
      page.items.map((item) => item.type),
      ["message", "tool", "message"],
    );
    const tool = page.items[1]!;
    assert.equal(tool.type, "tool");
    if (tool.type === "tool") {
      assert.equal(tool.activityId, "activity-1");
      assert.equal(tool.turnId, "turn-activity");
      assert.equal(tool.lifecycle, "tool.completed");
      assert.include(tool.detail, '"output": "done"');
    }
  });

  it("filters activity categories and omits runtime telemetry", () => {
    const page = packAgentTranscriptPage({
      messages: [makeMessage(0)],
      activities: [
        makeActivity("approval", "approval.requested", 1),
        makeActivity("compaction", "context-compaction", 2),
        makeActivity("telemetry", "context-window.updated", 3),
      ],
      include: new Set(["approvals"]),
    });

    assert.deepEqual(
      page.items.map((item) => item.type),
      ["approval"],
    );
  });

  it("uses the next older item as the cursor without duplicating an item", () => {
    const messages = [0, 1, 2].map((index) => ({
      ...makeMessage(index),
      sequence: index,
    }));
    const first = packAgentTranscriptPage({ messages, activities: [], limit: 2 });
    const second = packAgentTranscriptPage({
      messages,
      activities: [],
      limit: 2,
      ...(first.nextAnchor ? { anchor: first.nextAnchor } : {}),
    });

    assert.deepEqual(
      first.items.map((item) => item.type === "message" && item.messageId),
      ["m-1", "m-2"],
    );
    assert.deepEqual(
      second.items.map((item) => item.type === "message" && item.messageId),
      ["m-0"],
    );
    assert.isUndefined(second.nextAnchor);
  });
});
