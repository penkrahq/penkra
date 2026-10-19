import type { ProviderRuntimeEvent } from "@penkra/contracts";
import { assert, it } from "@effect/vitest";

import { toCleanCoreProviderEvents } from "./providerEventBridge.ts";

const base = {
  eventId: "evt-1",
  provider: "codex",
  threadId: "thread-1",
  createdAt: "2026-10-09T00:00:01.000Z",
  turnId: "turn-1",
} as const;

const bridge = (event: Record<string, unknown>) =>
  toCleanCoreProviderEvents(event as unknown as ProviderRuntimeEvent);

it("does not store runtime warnings as transcript notices", () => {
  assert.deepStrictEqual(
    bridge({ ...base, type: "runtime.warning", payload: { message: "diagnostic only" } }),
    [],
  );
});

it("maps turn.started / completed / aborted / session.exited", () => {
  assert.deepStrictEqual(bridge({ ...base, type: "turn.started", payload: {} }), [
    { type: "turn.started", threadId: "thread-1", turnId: "turn-1", at: base.createdAt },
  ]);
  assert.equal(
    (
      bridge({
        ...base,
        type: "turn.completed",
        payload: { state: "failed", errorMessage: "boom" },
      })[0] as {
        state: string;
        error: string;
      }
    ).state,
    "error",
  );
  assert.equal(
    (bridge({ ...base, type: "turn.aborted", payload: { reason: "stop" } })[0] as { state: string })
      .state,
    "interrupted",
  );
  assert.deepStrictEqual(bridge({ ...base, type: "session.exited", payload: {} }), [
    { type: "provider.exited", threadIds: ["thread-1"], at: base.createdAt },
  ]);
});

it("maps an assistant message completion to a done text item", () => {
  assert.deepStrictEqual(
    bridge({
      ...base,
      type: "item.completed",
      itemId: "msg-1",
      payload: { itemType: "assistant_message", status: "completed", detail: "final answer" },
    }),
    [
      {
        type: "item",
        threadId: "thread-1",
        item: {
          threadId: "thread-1",
          sourceId: "msg-1",
          turnId: "turn-1",
          kind: "text",
          status: "done",
          text: "final answer",
          data: null,
          createdAt: base.createdAt,
          updatedAt: base.createdAt,
        },
      },
    ],
  );
});

it("failed and declined text items are interrupted, never error", () => {
  for (const itemType of ["assistant_message"]) {
    for (const status of ["failed", "declined"]) {
      const [event] = bridge({
        ...base,
        type: "item.completed",
        itemId: "failed-item",
        payload: { itemType, status, detail: "Partial output" },
      });
      assert.equal(event?.type, "item");
      if (event?.type !== "item") throw new Error("Expected item completion");
      assert.equal(event.item.status, "interrupted");
      assert.equal(event.item.text, "Partial output");
    }
  }
});

it("maps a tool item to running/done and carries one canonical activity copy", () => {
  const started = bridge({
    ...base,
    type: "item.started",
    itemId: "call-1",
    payload: { itemType: "command_execution", status: "inProgress", input: { command: "ls" } },
  })[0] as { item: { kind: string; status: string; data: string } };
  assert.equal(started.item.kind, "tool");
  assert.equal(started.item.status, "running");
  assert.deepStrictEqual(JSON.parse(started.item.data), {
    tone: "tool",
    kind: "tool.started",
    summary: "Tool started",
    payload: { operationId: "call-1", itemType: "command_execution", status: "inProgress" },
  });

  const failed = bridge({
    ...base,
    type: "item.completed",
    itemId: "call-1",
    payload: { itemType: "command_execution", status: "failed" },
  })[0] as { item: { status: string; data: string } };
  assert.equal(failed.item.status, "error");
  assert.equal((JSON.parse(failed.item.data) as { kind: string }).kind, "tool.completed");
});

it("drops reasoning, plan and unknown items across providers and lifecycles", () => {
  for (const provider of ["codex", "claudeAgent", "opencode"])
    for (const type of ["item.started", "item.updated", "item.completed"])
      for (const itemType of ["reasoning", "plan", "unknown"])
        assert.deepStrictEqual(
          bridge({
            ...base,
            provider,
            type,
            itemId: "r1",
            payload: { itemType, status: "completed", detail: "Readable summary" },
          }),
          [],
        );
});

it("maps notice items", () => {
  assert.equal(
    (
      bridge({
        ...base,
        type: "item.completed",
        itemId: "c1",
        payload: { itemType: "context_compaction", status: "completed" },
      })[0] as {
        item: { kind: string };
      }
    ).item.kind,
    "notice",
  );
});

it("maps content deltas by stream kind", () => {
  assert.deepStrictEqual(
    bridge({
      ...base,
      type: "content.delta",
      itemId: "msg-1",
      payload: { streamKind: "assistant_text", delta: "he" },
    }),
    [
      {
        type: "delta",
        threadId: "thread-1",
        turnId: "turn-1",
        sourceId: "msg-1",
        kind: "text",
        delta: "he",
        at: base.createdAt,
      },
    ],
  );
  assert.deepStrictEqual(
    bridge({
      ...base,
      type: "content.delta",
      itemId: "r1",
      payload: { streamKind: "reasoning_text", delta: "why" },
    }),
    [],
  );
});

it("maps a question open and answer", () => {
  const opened = bridge({
    ...base,
    type: "user-input.requested",
    requestId: "req-1",
    payload: {
      questions: [{ id: "q1", header: "H", question: "Which database?", options: [] }],
    },
  })[0] as { item: { kind: string; status: string; text: string } };
  assert.equal(opened.item.kind, "question");
  assert.equal(opened.item.status, "open");
  assert.equal(opened.item.text, "Which database?");

  assert.deepStrictEqual(
    bridge({
      ...base,
      type: "user-input.resolved",
      requestId: "req-1",
      payload: { answers: { q1: "sqlite" } },
    }),
    [
      {
        type: "question.answered",
        threadId: "thread-1",
        sourceId: "req-1",
        answerData: '{"answers":{"q1":"sqlite"}}',
        at: base.createdAt,
      },
    ],
  );
});

it("maps runtime errors to notices and ignores unrelated events", () => {
  const notice = bridge({
    ...base,
    type: "runtime.error",
    payload: { message: "Aborted", terminal: true },
  })[0] as {
    item: { kind: string; text: string };
  };
  assert.equal(notice.item.kind, "notice");
  assert.equal(notice.item.text, "Aborted");
  assert.deepStrictEqual(bridge({ ...base, type: "account.rate-limits.updated", payload: {} }), []);
});

it("preserves the question lifecycle generation needed to answer from clean-core", () => {
  const event = bridge({
    ...base,
    type: "user-input.requested",
    requestId: "req-mobile",
    lifecycleGeneration: "generation-mobile",
    payload: {
      questions: [{ id: "tone", header: "Tone", question: "Playful or formal?", options: [] }],
    },
  })[0] as { item: { sourceId: string; data: string } };
  assert.equal(event.item.sourceId, "req-mobile");
  assert.equal(JSON.parse(event.item.data).lifecycleGeneration, "generation-mobile");
});
