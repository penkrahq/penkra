import { assert, it } from "@effect/vitest";
import { Effect, Fiber, Stream } from "effect";

import { applyProviderEvent } from "./providerStreamConsumer.ts";
import { threadChangeStream } from "./threadChangeStream.ts";
import { createThread, makeThreadPublisher } from "./threadStore.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";

it.live("emits a change for the subscribed thread only", () =>
  Effect.gen(function* () {
    const publisher = makeThreadPublisher();
    const collected = yield* Effect.scoped(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkScoped(
          Stream.runCollect(Stream.take(threadChangeStream(publisher, "thread-1"), 1)),
        );
        // Let the stream acquire its subscription before publishing.
        yield* Effect.sleep("20 millis");
        publisher.publish({ threadId: "thread-2" });
        publisher.publish({ threadId: "thread-1" });
        return yield* Fiber.join(fiber);
      }),
    );
    assert.deepStrictEqual(
      [...collected].map((change) => change.threadId),
      ["thread-1"],
    );
  }),
);

it.live("an event applied by the consumer reaches the subscribeThread stream", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    yield* createThread({
      id: "thread-1",
      spaceId: "space-1",
      title: "Hello",
      provider: "codex",
      model: "gpt-5.5",
      createdAt: "2026-10-09T00:00:00.000Z",
    });
    const publisher = makeThreadPublisher();
    const collected = yield* Effect.scoped(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkScoped(
          Stream.runCollect(Stream.take(threadChangeStream(publisher, "thread-1"), 1)),
        );
        yield* Effect.sleep("20 millis");
        yield* applyProviderEvent(publisher, {
          type: "turn.started",
          threadId: "thread-1",
          turnId: "turn-1",
          at: "2026-10-09T00:00:01.000Z",
        });
        return yield* Fiber.join(fiber);
      }),
    );
    assert.deepStrictEqual(
      [...collected].map((change) => change.threadId),
      ["thread-1"],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
