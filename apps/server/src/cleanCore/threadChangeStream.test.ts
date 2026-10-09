import { assert, it } from "@effect/vitest";
import { Effect, Fiber, Stream } from "effect";

import { threadChangeStream } from "./threadChangeStream.ts";
import { makeThreadPublisher } from "./threadStore.ts";

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
