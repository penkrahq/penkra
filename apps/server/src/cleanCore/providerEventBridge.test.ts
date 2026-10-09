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

it("maps turn.started to a running turn", () => {
  assert.deepStrictEqual(
    toCleanCoreProviderEvents({
      ...base,
      type: "turn.started",
      payload: {},
    } as ProviderRuntimeEvent),
    [{ type: "turn.started", threadId: "thread-1", turnId: "turn-1", at: base.createdAt }],
  );
});

it("maps a failed turn.completed to an error end with the message", () => {
  assert.deepStrictEqual(
    toCleanCoreProviderEvents({
      ...base,
      type: "turn.completed",
      payload: { state: "failed", errorMessage: "boom" },
    } as ProviderRuntimeEvent),
    [
      {
        type: "turn.ended",
        threadId: "thread-1",
        turnId: "turn-1",
        state: "error",
        error: "boom",
        at: base.createdAt,
      },
    ],
  );
});

it("maps interrupted/cancelled/aborted turns to interrupted", () => {
  assert.equal(
    (
      toCleanCoreProviderEvents({
        ...base,
        type: "turn.completed",
        payload: { state: "interrupted" },
      } as ProviderRuntimeEvent)[0] as { state: string }
    ).state,
    "interrupted",
  );
  assert.equal(
    (
      toCleanCoreProviderEvents({
        ...base,
        type: "turn.completed",
        payload: { state: "cancelled" },
      } as ProviderRuntimeEvent)[0] as { state: string }
    ).state,
    "interrupted",
  );
  assert.equal(
    (
      toCleanCoreProviderEvents({
        ...base,
        type: "turn.aborted",
        payload: { reason: "stop" },
      } as ProviderRuntimeEvent)[0] as {
        state: string;
      }
    ).state,
    "interrupted",
  );
});

it("maps session.exited to a provider exit and ignores unrelated events", () => {
  assert.deepStrictEqual(
    toCleanCoreProviderEvents({
      ...base,
      type: "session.exited",
      payload: {},
    } as ProviderRuntimeEvent),
    [{ type: "provider.exited", threadIds: ["thread-1"], at: base.createdAt }],
  );
  assert.deepStrictEqual(
    toCleanCoreProviderEvents({
      ...base,
      type: "account.rate-limits.updated",
      payload: {},
    } as unknown as ProviderRuntimeEvent),
    [],
  );
});
