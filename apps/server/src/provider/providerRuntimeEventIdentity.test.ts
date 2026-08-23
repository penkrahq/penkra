import {
  EventId,
  RuntimeItemId,
  RuntimeTaskId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@penkra/contracts";
import { describe, expect, it } from "vitest";

import {
  assignDerivedProviderRuntimeEventIds,
  providerRuntimeEventIdFromNative,
} from "./providerRuntimeEventIdentity.ts";
import { normalizeProviderRuntimeEvent } from "./Layers/ProviderService.ts";

const base = {
  eventId: EventId.makeUnsafe("native-event"),
  provider: "codex" as const,
  threadId: ThreadId.makeUnsafe("thread-derived-events"),
  createdAt: "2026-07-23T20:00:00.000Z",
};

describe("assignDerivedProviderRuntimeEventIds", () => {
  it("keeps singleton native ids unchanged", () => {
    const event = {
      ...base,
      type: "runtime.warning",
      payload: { message: "warning" },
    } satisfies ProviderRuntimeEvent;
    expect(assignDerivedProviderRuntimeEventIds([event])).toEqual([event]);
  });

  it("assigns stable distinct ids when one native event expands", () => {
    const events = [
      {
        ...base,
        type: "task.completed",
        payload: { taskId: RuntimeTaskId.makeUnsafe("task-1"), status: "completed" },
      },
      {
        ...base,
        type: "runtime.warning",
        payload: { message: "warning" },
      },
    ] satisfies ReadonlyArray<ProviderRuntimeEvent>;

    const assigned = assignDerivedProviderRuntimeEventIds(events);
    expect(assigned.map((event) => event.eventId)).toEqual([
      "native-event:task.completed:0",
      "native-event:runtime.warning:1",
    ]);
  });
});

describe("providerRuntimeEventIdFromNative", () => {
  it("normalizes provider-authored lifecycle text without flattening multiline content", () => {
    const event = {
      ...base,
      type: "item.completed",
      itemId: RuntimeItemId.makeUnsafe("item-whitespace"),
      payload: {
        itemType: "command_execution",
        title: "  Bash: cd /tmp;\n  ./node_modules/.bin/vitest run  \n",
        detail: "   ",
      },
    } satisfies ProviderRuntimeEvent;

    const normalized = normalizeProviderRuntimeEvent(event);
    expect(normalized.payload).toEqual({
      itemType: "command_execution",
      title: "Bash: cd /tmp;\n  ./node_modules/.bin/vitest run",
    });
  });

  it("preserves distinct occurrence ids for identical raw assistant deltas", () => {
    const makeDelta = (eventId: string) =>
      ({
        ...base,
        eventId: EventId.makeUnsafe(eventId),
        type: "content.delta",
        itemId: RuntimeItemId.makeUnsafe("assistant-repeated-chunk"),
        payload: { streamKind: "assistant_text", delta: " is" },
        raw: {
          source: "codex.app-server.notification",
          method: "item/agentMessage/delta",
          payload: {
            threadId: "provider-thread",
            turnId: "provider-turn",
            itemId: "assistant-repeated-chunk",
            delta: " is",
          },
        },
      }) satisfies ProviderRuntimeEvent;

    expect([
      normalizeProviderRuntimeEvent(makeDelta("delta-occurrence-1")).eventId,
      normalizeProviderRuntimeEvent(makeDelta("delta-occurrence-2")).eventId,
    ]).toEqual(["delta-occurrence-1", "delta-occurrence-2"]);
  });

  it("preserves assistant completion text byte-for-byte", () => {
    const event = {
      ...base,
      type: "item.completed",
      itemId: RuntimeItemId.makeUnsafe("assistant-completion-whitespace"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        title: " Assistant message ",
        detail: "  first line\nsecond line\n",
      },
    } satisfies ProviderRuntimeEvent;

    expect(normalizeProviderRuntimeEvent(event).payload).toEqual({
      itemType: "assistant_message",
      status: "completed",
      title: "Assistant message",
      detail: "  first line\nsecond line\n",
    });
  });

  it("is stable across replay and JSON object key order", () => {
    const first = providerRuntimeEventIdFromNative({
      provider: "claude",
      source: "claude.sdk.message",
      threadId: "thread-1",
      nativeEvent: { type: "part.updated", properties: { id: "part-1", text: "hello" } },
    });
    const replay = providerRuntimeEventIdFromNative({
      provider: "claude",
      source: "claude.sdk.message",
      threadId: "thread-1",
      nativeEvent: { properties: { text: "hello", id: "part-1" }, type: "part.updated" },
    });
    expect(replay).toBe(first);
  });

  it("scopes identical native payloads by provider, source, and thread", () => {
    const make = (provider: string, source: string, threadId: string) =>
      providerRuntimeEventIdFromNative({
        provider,
        source,
        threadId,
        nativeEvent: { type: "session.idle", properties: { sessionID: "shared" } },
      });
    expect(
      new Set([
        make("claude", "claude.sdk.message", "thread-1"),
        make("opencode", "opencode.sdk.event", "thread-1"),
        make("claude", "other.source", "thread-1"),
        make("claude", "claude.sdk.message", "thread-2"),
      ]).size,
    ).toBe(4);
  });
});
