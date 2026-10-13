import { assert, it } from "@effect/vitest";
import {
  EventId,
  ProviderConnectionId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@penkra/contracts";
import { Cause, Effect, Exit, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  ConnectionRateLimits,
  ConnectionRateLimitsLive,
} from "../providerUsage/ConnectionRateLimits.ts";
import { applyProviderRuntimeEvent } from "./providerStreamConsumer.ts";
import { seedThreadFolderFixture } from "./threadFixtures.ts";
import { createThread, makeThreadPublisher, upsertThreadItem } from "./threadStore.ts";

const at = "2026-10-11T00:00:00.000Z";
const threadId = ThreadId.makeUnsafe("thread");
const owner = ProviderConnectionId.makeUnsafe("bound-owner");
const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations();
  yield* seedThreadFolderFixture("folder", "space");
  yield* createThread({
    id: threadId,
    folderId: "folder",
    spaceId: "space",
    title: "Thread",
    provider: "claudeAgent",
    model: "model",
    runtimeMode: "full-access",
    createdBy: "user",
    createdAt: at,
  });
  yield* sql`INSERT INTO provider_connections (connection_id, harness_kind, authentication_target_id, authentication_method_id, label, profile_ref, health_status, lifecycle, created_at, updated_at) VALUES (${owner}, 'claudeAgent', 'anthropic-first-party', 'claude-account', 'Owner', 'provider-profile:owner', 'ready', 'active', ${at}, ${at})`;
  yield* sql`UPDATE threads SET connection_id=${owner},native_state_id='native', state='running', active_turn_id='turn' WHERE id=${threadId}`;
});
const withDb = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient | ConnectionRateLimits>) =>
  setup.pipe(
    Effect.andThen(effect),
    Effect.provide(ConnectionRateLimitsLive),
    Effect.provide(NodeSqliteClient.layerMemory()),
  );
const completed = (
  provider: ProviderRuntimeEvent["provider"],
  usage: unknown,
): ProviderRuntimeEvent => ({
  type: "turn.completed",
  eventId: EventId.makeUnsafe("completed"),
  threadId,
  turnId: TurnId.makeUnsafe("turn"),
  provider,
  createdAt: at,
  payload: { state: "completed", usage },
});

it.effect("attributes Claude usage to the binding and commits it once with the turn end", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const publisher = makeThreadPublisher();
      const broadcasts: string[] = [];
      publisher.subscribeAll((change) => broadcasts.push(change.threadId));
      const event = completed("claudeAgent", {
        input_tokens: 1000,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 300,
        output_tokens: 75,
      });
      yield* applyProviderRuntimeEvent(publisher, event);
      yield* applyProviderRuntimeEvent(publisher, event);
      assert.deepStrictEqual(
        yield* sql`SELECT connection_id, input_tokens, output_tokens, turns FROM connection_usage_daily`,
        [{ connection_id: owner, input_tokens: 1500, output_tokens: 75, turns: 1 }],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT state, active_turn_id FROM threads WHERE id=${threadId}`,
        [{ state: "idle", active_turn_id: null }],
      );
      assert.deepStrictEqual(broadcasts, [threadId, threadId]);
    }),
  ),
);

it.effect("normalizes Codex camelCase and nested reasoning counters", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* applyProviderRuntimeEvent(
        makeThreadPublisher(),
        completed("codex", {
          inputTokens: 120,
          outputTokens: 30,
          outputTokensDetails: { reasoningTokens: 9 },
        }),
      );
      assert.deepStrictEqual(
        yield* sql`SELECT input_tokens, output_tokens, reasoning_output_tokens FROM connection_usage_daily`,
        [{ input_tokens: 120, output_tokens: 30, reasoning_output_tokens: 9 }],
      );
    }),
  ),
);

it.effect("updates process-local rate limits on the binding without writing token usage", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const limits = yield* ConnectionRateLimits;
      const event: ProviderRuntimeEvent = {
        type: "account.rate-limits.updated",
        eventId: EventId.makeUnsafe("quota"),
        threadId,
        provider: "claudeAgent",
        createdAt: at,
        payload: { rateLimits: { status: "available", remaining: 8 } },
      };
      const publisher = makeThreadPublisher();
      const broadcasts: string[] = [];
      publisher.subscribeAll((change) => broadcasts.push(change.threadId));
      yield* applyProviderRuntimeEvent(publisher, event);
      const observation = yield* limits.get(owner);
      assert.isTrue(Option.isSome(observation));
      if (Option.isSome(observation)) {
        assert.equal(observation.value.status, "available");
        assert.equal(observation.value.sourceEventId, "quota");
        assert.deepStrictEqual(JSON.parse(observation.value.limitsJson), {
          status: "available",
          remaining: 8,
        });
      }
      assert.deepStrictEqual(yield* sql`SELECT * FROM connection_usage_daily`, []);
      assert.deepStrictEqual(broadcasts, []);
    }),
  ),
);

it.effect(
  "rolls usage back with a failed item settlement and surfaces the statement error without broadcasting",
  () =>
    withDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* upsertThreadItem({
          threadId,
          sourceId: "stream",
          turnId: "turn",
          kind: "text",
          status: "streaming",
          text: "partial",
          data: null,
          createdAt: at,
          updatedAt: at,
        });
        const before = yield* sql`SELECT * FROM threads WHERE id=${threadId}`;
        yield* sql`CREATE TEMP TRIGGER fail_settlement BEFORE UPDATE OF status ON thread_items BEGIN SELECT RAISE(ABORT, 'settlement failed'); END`;
        const publisher = makeThreadPublisher();
        const broadcasts: string[] = [];
        const outcomes: string[] = [];
        publisher.subscribeAll((change) => broadcasts.push(change.threadId));
        publisher.subscribeProvider((event) => outcomes.push(event.type));
        const result = yield* Effect.exit(
          applyProviderRuntimeEvent(
            publisher,
            completed("claudeAgent", { input_tokens: 1, output_tokens: 2 }),
          ),
        );
        assert.isTrue(Exit.isFailure(result));
        if (Exit.isFailure(result)) assert.include(Cause.pretty(result.cause), "settlement failed");
        assert.deepStrictEqual(yield* sql`SELECT * FROM threads WHERE id=${threadId}`, before);
        assert.deepStrictEqual(
          yield* sql`SELECT status FROM thread_items WHERE thread_id=${threadId}`,
          [{ status: "streaming" }],
        );
        assert.deepStrictEqual(yield* sql`SELECT * FROM connection_usage_daily`, []);
        assert.deepStrictEqual(yield* sql`SELECT * FROM connection_usage_turn_events`, []);
        assert.deepStrictEqual(broadcasts, []);
        assert.deepStrictEqual(outcomes, []);
        yield* sql`DROP TRIGGER fail_settlement`;
        yield* applyProviderRuntimeEvent(
          publisher,
          completed("claudeAgent", { input_tokens: 1, output_tokens: 2 }),
        );
        assert.deepStrictEqual(
          yield* sql`SELECT input_tokens, output_tokens, turns FROM connection_usage_daily`,
          [{ input_tokens: 1, output_tokens: 2, turns: 1 }],
        );
        assert.deepStrictEqual(broadcasts, [threadId]);
        assert.deepStrictEqual(outcomes, ["turn.ended"]);
      }),
    ),
);
