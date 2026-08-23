import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ProviderKind } from "@penkra/contracts";
import { assert, it, vi } from "@effect/vitest";
import { assertFailure } from "@effect/vitest/utils";
import { Effect, Layer, Stream } from "effect";

import { ProviderUnsupportedError } from "../Errors.ts";
import { ClaudeAdapter, type ClaudeAdapterShape } from "../Services/ClaudeAdapter.ts";
import { CodexAdapter, type CodexAdapterShape } from "../Services/CodexAdapter.ts";
import { OpenCodeAdapter, type OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderAdapterRegistryLive } from "./ProviderAdapterRegistry.ts";

const baseAdapter = {
  capabilities: { sessionModelSwitch: "in-session" as const },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  drainRuntimeEvents: Effect.void,
  streamEvents: Stream.empty,
};

const fakeCodexAdapter: CodexAdapterShape = {
  ...baseAdapter,
  provider: "codex",
  steerTurn: vi.fn(),
};
const fakeClaudeAdapter: ClaudeAdapterShape = {
  ...baseAdapter,
  provider: "claudeAgent",
  steerTurn: vi.fn(),
  stopTask: vi.fn(),
  backgroundTask: vi.fn(),
  steerSubagent: vi.fn(),
};
const fakeOpenCodeAdapter: OpenCodeAdapterShape = {
  ...baseAdapter,
  provider: "opencode",
};

const layer = it.layer(
  Layer.mergeAll(
    Layer.provide(
      ProviderAdapterRegistryLive,
      Layer.mergeAll(
        Layer.succeed(CodexAdapter, fakeCodexAdapter),
        Layer.succeed(ClaudeAdapter, fakeClaudeAdapter),
        Layer.succeed(OpenCodeAdapter, fakeOpenCodeAdapter),
      ),
    ),
    NodeServices.layer,
  ),
);

layer("ProviderAdapterRegistryLive", (it) => {
  it.effect("resolves exactly the three implemented provider adapters", () =>
    Effect.gen(function* () {
      const registry = yield* ProviderAdapterRegistry;
      assert.equal(yield* registry.getByProvider("codex"), fakeCodexAdapter);
      assert.equal(yield* registry.getByProvider("claudeAgent"), fakeClaudeAdapter);
      assert.equal(yield* registry.getByProvider("opencode"), fakeOpenCodeAdapter);
      assert.deepEqual(yield* registry.listProviders(), ["codex", "claudeAgent", "opencode"]);
    }),
  );

  it.effect("fails with ProviderUnsupportedError for unknown providers", () =>
    Effect.gen(function* () {
      const registry = yield* ProviderAdapterRegistry;
      const adapter = yield* registry.getByProvider("unknown" as ProviderKind).pipe(Effect.result);
      assertFailure(adapter, new ProviderUnsupportedError({ provider: "unknown" }));
    }),
  );
});
