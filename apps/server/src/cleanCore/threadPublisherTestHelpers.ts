// Purpose: Scoped PubSub observers for existing persistence tests; not imported by runtime code.
import { Effect, Fiber, PubSub, Stream } from "effect";
import type { InvalidationHub } from "./invalidationHub.ts";

export const observePublisher = <A>(
  hub: PubSub.PubSub<A> | InvalidationHub<A>,
  listener: (event: A) => void,
  accepts: (event: A) => boolean = () => true,
) =>
  Effect.gen(function* () {
    let active = true;
    const stream = "stream" in hub ? hub.stream() : Stream.fromPubSub(hub);
    const fiber = yield* stream.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          if (active && accepts(event)) listener(event);
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    return () => {
      active = false;
      Effect.runFork(Fiber.interrupt(fiber));
    };
  });
