import { EventId, RuntimeTaskId, ThreadId, type ProviderRuntimeEvent } from "@penkra/contracts";
import { describe, expect, it } from "vitest";

import {
  assignDerivedProviderRuntimeEventIds,
  providerRuntimeEventIdFromNative,
} from "./providerRuntimeEventIdentity.ts";
import { canonicalizeProviderRuntimeEventIdentity } from "./Layers/ProviderService.ts";

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
  it("enforces stable raw-notification identity at the shared adapter boundary", () => {
    const event = {
      type: "runtime.warning" as const,
      eventId: EventId.makeUnsafe("random-on-each-replay"),
      provider: "pi" as const,
      createdAt: "2026-08-19T00:00:00.000Z",
      threadId: ThreadId.makeUnsafe("thread-shared-boundary"),
      payload: { message: "retrying" },
      raw: {
        source: "pi.sdk.event",
        payload: { sequence: 7, nested: { b: 2, a: 1 } },
      },
    } satisfies ProviderRuntimeEvent;
    const replay = {
      ...event,
      eventId: EventId.makeUnsafe("another-random-id"),
      raw: {
        source: "pi.sdk.event",
        payload: { nested: { a: 1, b: 2 }, sequence: 7 },
      },
    } satisfies ProviderRuntimeEvent;
    expect(canonicalizeProviderRuntimeEventIdentity(event).eventId).toBe(
      canonicalizeProviderRuntimeEventIdentity(replay).eventId,
    );
  });

  it("is stable across replay and JSON object key order", () => {
    const first = providerRuntimeEventIdFromNative({
      provider: "opencode",
      source: "opencode.sdk.event",
      threadId: "thread-1",
      nativeEvent: { type: "part.updated", properties: { id: "part-1", text: "hello" } },
    });
    const replay = providerRuntimeEventIdFromNative({
      provider: "opencode",
      source: "opencode.sdk.event",
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
        make("opencode", "opencode.sdk.event", "thread-1"),
        make("kilo", "kilo.sdk.event", "thread-1"),
        make("opencode", "other.source", "thread-1"),
        make("opencode", "opencode.sdk.event", "thread-2"),
      ]).size,
    ).toBe(4);
  });
});
