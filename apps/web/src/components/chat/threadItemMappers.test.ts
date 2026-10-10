import type { CleanCoreThreadItem } from "@penkra/contracts";
import { describe, expect, it } from "vitest";

import {
  threadItemToActivity,
  threadItemToChatMessage,
  threadItemToPendingUserInput,
  threadItemToUserContent,
  threadItemToWorkLogEntry,
  threadItemsToTimelineEntries,
} from "./threadItemMappers";

const item = (
  kind: CleanCoreThreadItem["kind"],
  overrides: Partial<CleanCoreThreadItem> = {},
): CleanCoreThreadItem => ({
  threadId: "thread-1" as CleanCoreThreadItem["threadId"],
  seq: 7,
  sourceId: "s-7",
  turnId: null,
  kind,
  status: "done",
  text: "hello",
  data: null,
  createdAt: "2026-10-09T00:00:00.000Z",
  updatedAt: "2026-10-09T00:00:00.000Z",
  ...overrides,
});

describe("threadItemToActivity", () => {
  it("rebuilds the canonical activity from an activity-shaped data copy", () => {
    const activity = threadItemToActivity(
      item("tool", {
        sourceId: "call-1",
        seq: 4,
        turnId: "turn-1" as CleanCoreThreadItem["turnId"],
        text: "Bash",
        data: JSON.stringify({
          tone: "tool",
          kind: "tool.completed",
          summary: "Bash",
          payload: { title: "Bash", status: "completed" },
        }),
      }),
    );
    expect(activity).toMatchObject({
      id: "call-1",
      tone: "tool",
      kind: "tool.completed",
      summary: "Bash",
      payload: { title: "Bash", status: "completed" },
      turnId: "turn-1",
      sequence: 4,
    });
  });

  it("falls back to the item text when data is not JSON", () => {
    const activity = threadItemToActivity(
      item("tool", { text: "Plain result", data: "<task_result>Plain result</task_result>" }),
    );
    expect(activity.kind).toBe("tool.completed");
    expect(activity.payload).toEqual({ detail: "Plain result", status: "completed" });
  });

  it("coerces a warning notice tone and defaults the notice kind", () => {
    const activity = threadItemToActivity(
      item("notice", {
        text: "be careful",
        data: JSON.stringify({ tone: "warning", payload: { message: "be careful" } }),
      }),
    );
    expect(activity.tone).toBe("info");
    expect(activity.kind).toBe("runtime.warning");
    expect(activity.payload).toEqual({ message: "be careful" });
  });
});

describe("threadItemToWorkLogEntry", () => {
  it("derives a work-log entry from a tool item", () => {
    const entry = threadItemToWorkLogEntry(
      item("tool", {
        sourceId: "call-1",
        text: "Bash",
        data: JSON.stringify({
          tone: "tool",
          kind: "tool.completed",
          summary: "Bash",
          payload: {
            title: "Bash",
            status: "completed",
            data: { toolCallId: "call-1", toolName: "Bash", command: "ls" },
          },
        }),
      }),
    );
    expect(entry).not.toBeNull();
    expect(entry?.toolName).toBe("Bash");
    expect(entry?.activityKind).toBe("tool.completed");
  });

  it("derives an info entry from a notice item", () => {
    const entry = threadItemToWorkLogEntry(
      item("notice", {
        text: "be careful",
        data: JSON.stringify({
          tone: "info",
          kind: "runtime.warning",
          summary: "Runtime warning",
          payload: { message: "be careful", detail: "be careful" },
        }),
      }),
    );
    expect(entry?.activityKind).toBe("runtime.warning");
    expect(entry?.detail).toBe("be careful");
  });
});

describe("threadItemToPendingUserInput", () => {
  it("maps questions and strips the migration source prefix", () => {
    const pending = threadItemToPendingUserInput(
      item("question", {
        sourceId: "question:req-1",
        status: "open",
        data: JSON.stringify({
          questions: [{ id: "q1", header: "H", question: "Which database?", options: [] }],
        }),
      }),
    );
    expect(pending.requestId).toBe("req-1");
    expect(pending.questions).toHaveLength(1);
    expect(pending.questions[0]?.question).toBe("Which database?");
  });

  it("yields no questions when the data copy has none", () => {
    const pending = threadItemToPendingUserInput(
      item("question", { sourceId: "req-2", data: JSON.stringify({ requestId: "req-2" }) }),
    );
    expect(pending.requestId).toBe("req-2");
    expect(pending.questions).toEqual([]);
  });
});

describe("threadItemToChatMessage", () => {
  it("maps a user item to a user ChatMessage with its attachments and seq", () => {
    const message = threadItemToChatMessage(
      item("user", {
        sourceId: "msg-1",
        seq: 2,
        text: "please build the thing",
        data: JSON.stringify({
          attachments: [
            { type: "file", id: "f1", name: "notes.txt", mimeType: "text/plain", sizeBytes: 12 },
          ],
          dispatchMode: "steer",
        }),
      }),
    );
    expect(message.id).toBe("msg-1");
    expect(message.role).toBe("user");
    expect(message.sequence).toBe(2);
    expect(message.attachments).toHaveLength(1);
    expect(message.dispatchMode).toBe("steer");
    expect(message.streaming).toBe(false);
  });

  it("maps sender attribution from item data for another thread's send", () => {
    const message = threadItemToChatMessage(
      item("user", {
        sourceId: "msg-sender",
        text: "sent by another thread",
        data: JSON.stringify({ senderThreadId: "thread-sender", dispatchOrigin: "agent" }),
      }),
    );
    expect(message.senderThreadId).toBe("thread-sender");
    expect(message.dispatchOrigin).toBe("agent");
  });

  it("maps a text item to an assistant ChatMessage and keeps streaming", () => {
    const message = threadItemToChatMessage(
      item("text", { sourceId: "msg-2", seq: 3, status: "streaming", text: "partial" }),
    );
    expect(message.role).toBe("assistant");
    expect(message.streaming).toBe(true);
    expect(message.completedAt).toBeUndefined();
  });
});

describe("threadItemsToTimelineEntries", () => {
  it("interleaves message and work rows in seq order", () => {
    const entries = threadItemsToTimelineEntries([
      item("tool", {
        sourceId: "call-1",
        seq: 3,
        text: "Bash",
        data: JSON.stringify({
          tone: "tool",
          kind: "tool.completed",
          summary: "Bash",
          payload: { title: "Bash", status: "completed" },
        }),
      }),
      item("user", { sourceId: "msg-1", seq: 1, text: "hello" }),
      item("text", { sourceId: "msg-2", seq: 2, text: "hi there" }),
    ]);
    expect(entries.map((entry) => [entry.kind, entry.id])).toEqual([
      ["message", "msg-1"],
      ["message", "msg-2"],
      ["work", "call-1"],
    ]);
    const first = entries[0];
    expect(first?.kind).toBe("message");
    if (first?.kind === "message") {
      expect(first.message.role).toBe("user");
    }
  });

  it("keeps a question item as a work row so it is not lost", () => {
    const entries = threadItemsToTimelineEntries([
      item("question", { sourceId: "question:req-1", seq: 1, status: "open", text: "Which db?" }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("work");
  });
});

describe("threadItemToUserContent", () => {
  it("keeps attachments, skills, mentions and dispatch metadata", () => {
    const content = threadItemToUserContent(
      item("user", {
        text: "please build the thing",
        data: JSON.stringify({
          attachments: [
            { type: "file", id: "f1", name: "notes.txt", mimeType: "text/plain", sizeBytes: 12 },
          ],
          skills: [{ name: "skill-a" }],
          mentions: [{ path: "src/app.ts" }],
          dispatchMode: "steer",
          dispatchOrigin: "agent",
        }),
      }),
    );
    expect(content.text).toBe("please build the thing");
    expect(content.attachments).toHaveLength(1);
    expect(content.skills).toHaveLength(1);
    expect(content.mentions).toHaveLength(1);
    expect(content.dispatchMode).toBe("steer");
    expect(content.dispatchOrigin).toBe("agent");
  });
});
