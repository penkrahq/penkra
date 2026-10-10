import { assert, it } from "@effect/vitest";
import { MessageId } from "@penkra/contracts";
import { Deferred, Effect, Fiber } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  sendMessage,
  playThread,
  PLAY_TURN_RECOVERY_PROMPT,
  type SendDriver,
} from "./sendMessage.ts";
import { createThread, makeThreadPublisher } from "./threadStore.ts";
import { applyProviderEvent } from "./providerStreamConsumer.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";

const at = "2026-10-09T00:00:01.000Z";
const message = {
  messageId: MessageId.makeUnsafe("m1"),
  text: "hi",
  attachments: [],
  senderThreadId: null,
  dispatchOrigin: "user" as const,
  queuedAt: at,
};
const withDb = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layerMemory()));
const setup = Effect.gen(function* () {
  yield* runMigrations();
  yield* createThread({
    id: "thread-1",
    spaceId: "space-1",
    title: "Hello",
    provider: "codex",
    model: "gpt-5.5",
    runtimeMode: "full-access",
    createdBy: "user",
    createdAt: at,
  });
  return makeThreadPublisher();
});
const input = {
  threadId: "thread-1",
  message,
  dispatchMode: "queue" as const,
  supportsSteer: true,
};

it.effect("started waits for the exact provider start, then records the delivered item", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const publisher = yield* setup;
      const dispatched = yield* Deferred.make<void>();
      const driver: SendDriver = {
        claimAttachments: () => Effect.void,
        dispatch: () => Deferred.succeed(dispatched, undefined).pipe(Effect.as("turn-1")),
        interrupt: () => Effect.void,
      };
      const fiber = yield* Effect.forkChild(sendMessage(publisher, driver, input));
      yield* Deferred.await(dispatched);
      assert.deepStrictEqual(yield* sql`SELECT source_id FROM thread_items`, []);
      publisher.publishProvider({
        type: "turn.started",
        threadId: "other-thread",
        turnId: "turn-1",
        at,
      });
      publisher.publishProvider({
        type: "turn.started",
        threadId: "thread-1",
        turnId: "other-turn",
        at,
      });
      yield* applyProviderEvent(publisher, {
        type: "turn.started",
        threadId: "thread-1",
        turnId: "turn-1",
        at,
      });
      assert.deepStrictEqual(JSON.parse(JSON.stringify(yield* Fiber.join(fiber))), {
        threadId: "thread-1",
        messageId: "m1",
        delivery: "started",
        turnId: "turn-1",
      });
      assert.deepStrictEqual(yield* sql`SELECT source_id, turn_id, status FROM thread_items`, [
        { source_id: "m1", turn_id: "turn-1", status: "sent" },
      ]);
    }),
  ),
);

it.effect("steered returns only after the provider acknowledges it", () =>
  withDb(
    Effect.gen(function* () {
      const publisher = yield* setup;
      yield* applyProviderEvent(publisher, {
        type: "turn.started",
        threadId: "thread-1",
        turnId: "running-turn",
        at,
      });
      const acknowledged = yield* Deferred.make<string, Error>();
      const driver: SendDriver = {
        claimAttachments: () => Effect.void,
        dispatch: (_, mode) => {
          assert.equal(mode, "steer");
          return Deferred.await(acknowledged);
        },
        interrupt: () => Effect.die("must not interrupt"),
      };
      const fiber = yield* Effect.forkChild(
        sendMessage(publisher, driver, { ...input, dispatchMode: "steer" }),
      );
      yield* Deferred.succeed(acknowledged, "running-turn");
      assert.deepStrictEqual(JSON.parse(JSON.stringify(yield* Fiber.join(fiber))), {
        threadId: "thread-1",
        messageId: "m1",
        delivery: "steered",
        turnId: "running-turn",
      });
    }),
  ),
);

it.effect("interrupted waits for the old turn to end and for the new turn to start", () =>
  withDb(
    Effect.gen(function* () {
      const publisher = yield* setup;
      yield* applyProviderEvent(publisher, {
        type: "turn.started",
        threadId: "thread-1",
        turnId: "old",
        at,
      });
      const interrupted = yield* Deferred.make<void>();
      const dispatched = yield* Deferred.make<void>();
      const driver: SendDriver = {
        claimAttachments: () => Effect.void,
        interrupt: () => Deferred.succeed(interrupted, undefined).pipe(Effect.asVoid),
        dispatch: () => Deferred.succeed(dispatched, undefined).pipe(Effect.as("next")),
      };
      const fiber = yield* Effect.forkChild(
        sendMessage(publisher, driver, { ...input, dispatchMode: "steer", supportsSteer: false }),
      );
      yield* Deferred.await(interrupted);
      yield* applyProviderEvent(publisher, {
        type: "turn.ended",
        threadId: "thread-1",
        turnId: "old",
        state: "interrupted",
        at,
      });
      yield* Deferred.await(dispatched);
      yield* applyProviderEvent(publisher, {
        type: "turn.started",
        threadId: "thread-1",
        turnId: "next",
        at,
      });
      assert.deepStrictEqual(JSON.parse(JSON.stringify(yield* Fiber.join(fiber))), {
        threadId: "thread-1",
        messageId: "m1",
        delivery: "interrupted",
        turnId: "next",
      });
    }),
  ),
);

it.effect(
  "queued reports the committed position, length and running turn without a transcript item",
  () =>
    withDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const publisher = yield* setup;
        yield* applyProviderEvent(publisher, {
          type: "turn.started",
          threadId: "thread-1",
          turnId: "running",
          at,
        });
        const driver: SendDriver = {
          claimAttachments: () => Effect.void,
          dispatch: () => Effect.die("queued must not dispatch"),
          interrupt: () => Effect.die("queued must not interrupt"),
        };
        assert.deepStrictEqual(
          JSON.parse(JSON.stringify(yield* sendMessage(publisher, driver, input))),
          {
            threadId: "thread-1",
            messageId: "m1",
            delivery: "queued",
            position: 1,
            queueLength: 1,
            runningTurnId: "running",
          },
        );
        assert.deepStrictEqual(yield* sql`SELECT source_id FROM thread_items`, []);
        const rows = yield* sql<{ queue: string }>`SELECT queue FROM threads`;
        assert.deepStrictEqual(JSON.parse(rows[0]!.queue), [message]);
      }),
    ),
);

it.effect("failed preserves the provider message, previous thread state and empty transcript", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const publisher = yield* setup;
      const error = "Provider rejected: invalid credentials\nOriginal detail";
      const driver: SendDriver = {
        claimAttachments: () => Effect.void,
        dispatch: () => Effect.fail(new Error(error)),
        interrupt: () => Effect.void,
      };
      assert.deepStrictEqual(
        JSON.parse(JSON.stringify(yield* sendMessage(publisher, driver, input))),
        { threadId: "thread-1", messageId: "m1", delivery: "failed", error },
      );
      assert.deepStrictEqual(yield* sql`SELECT state FROM threads`, [{ state: "idle" }]);
      assert.deepStrictEqual(yield* sql`SELECT source_id FROM thread_items`, []);
    }),
  ),
);

it.effect(
  "provider exit before acknowledgement returns its unchanged message and releases the caller",
  () =>
    withDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const publisher = yield* setup;
        const dispatched = yield* Deferred.make<void>();
        const reply = yield* Deferred.make<string, Error>();
        const driver: SendDriver = {
          claimAttachments: () => Effect.void,
          dispatch: () =>
            Deferred.succeed(dispatched, undefined).pipe(Effect.andThen(Deferred.await(reply))),
          interrupt: () => Effect.void,
        };
        const fiber = yield* Effect.forkChild(sendMessage(publisher, driver, input));
        yield* Deferred.await(dispatched);
        publisher.publishProvider({
          type: "provider.exited",
          threadIds: ["thread-1"],
          reason: "Provider exited: authentication rejected",
          at,
        });
        assert.deepStrictEqual(JSON.parse(JSON.stringify(yield* Fiber.join(fiber))), {
          threadId: "thread-1",
          messageId: "m1",
          delivery: "failed",
          error: "Provider exited: authentication rejected",
        });
        assert.deepStrictEqual(yield* sql`SELECT state FROM threads`, [{ state: "idle" }]);
        assert.deepStrictEqual(yield* sql`SELECT source_id FROM thread_items`, []);
      }),
    ),
);

it.effect("play only sends the recovery prompt for an idle cut-off thread", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const publisher = yield* setup;
      const driver: SendDriver = {
        claimAttachments: () => Effect.void,
        dispatch: () =>
          Effect.sync(() => {
            publisher.publishProvider({
              type: "turn.started",
              threadId: "thread-1",
              turnId: "recovery-turn",
              at,
            });
            return "recovery-turn";
          }),
        interrupt: () => Effect.void,
      };
      assert.isNull(yield* playThread(publisher, driver, { threadId: "thread-1", message }));
      yield* applyProviderEvent(publisher, {
        type: "turn.started",
        threadId: "thread-1",
        turnId: "cut-off",
        at,
      });
      yield* applyProviderEvent(publisher, {
        type: "provider.exited",
        threadIds: ["thread-1"],
        at,
      });
      const result = yield* playThread(publisher, driver, { threadId: "thread-1", message });
      assert.equal(result?.delivery, "started");
      const items = yield* sql<{
        text: string;
      }>`SELECT text FROM thread_items WHERE source_id = ${message.messageId}`;
      assert.deepStrictEqual(items, [{ text: PLAY_TURN_RECOVERY_PROMPT }]);
    }),
  ),
);
