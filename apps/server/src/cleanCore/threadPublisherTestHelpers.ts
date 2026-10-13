// Purpose: Scoped PubSub observers for existing persistence tests; not imported by runtime code.
import { Effect, Fiber, PubSub } from "effect";

export const observePublisher = <A>(
  hub: PubSub.PubSub<A>,
  listener: (event: A) => void,
  accepts: (event: A) => boolean = () => true,
) =>
  Effect.gen(function* () {
    const subscription = yield* PubSub.subscribe(hub);
    let active = true;
    const fiber = yield* PubSub.take(subscription).pipe(
      Effect.andThen((event) =>
        Effect.sync(() => {
          if (active && accepts(event)) listener(event);
        }),
      ),
      Effect.forever,
      Effect.forkScoped({ startImmediately: true }),
    );
    return () => {
      active = false;
      Effect.runFork(Fiber.interrupt(fiber));
    };
  });
