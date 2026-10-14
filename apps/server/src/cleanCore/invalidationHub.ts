// Coalesced dirty keys, not an event journal. Publishing never runs subscriber code.
import { Effect, PubSub, Stream } from "effect";

export interface InvalidationHub<A> {
  readonly stream: (onlyKey?: string) => Stream.Stream<A>;
  readonly publish: (value: A) => void;
  readonly close: Effect.Effect<void>;
}
export function makeInvalidationHub<A>(
  keyOf: (value: A) => string,
  merge: (previous: A, next: A) => A = (_, next) => next,
): InvalidationHub<A> {
  const subscribers = new Set<{
    onlyKey: string | undefined;
    pending: Map<string, A>;
    wake: PubSub.PubSub<void>;
  }>();
  let closed = false;
  return {
    stream: (onlyKey) =>
      Stream.unwrap(
        Effect.gen(function* () {
          // One wake-up is sufficient: all dirty keys live in the map, once per key.
          const wake = yield* PubSub.sliding<void>(1);
          const subscription = yield* PubSub.subscribe(wake);
          const subscriber = { onlyKey, pending: new Map<string, A>(), wake };
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              if (!closed) subscribers.add(subscriber);
            }),
            () =>
              Effect.sync(() => subscribers.delete(subscriber)).pipe(
                Effect.andThen(PubSub.shutdown(wake)),
              ),
          );
          if (closed) yield* PubSub.shutdown(wake);
          return Stream.fromEffectRepeat(PubSub.take(subscription)).pipe(
            Stream.flatMap(() => {
              const pending = Array.from(subscriber.pending.values());
              subscriber.pending.clear();
              return Stream.fromIterable(pending);
            }),
          );
        }),
      ),
    publish: (value) => {
      if (closed) return;
      const key = keyOf(value);
      for (const subscriber of subscribers) {
        if (subscriber.onlyKey !== undefined && subscriber.onlyKey !== key) continue;
        const previous = subscriber.pending.get(key);
        subscriber.pending.set(key, previous === undefined ? value : merge(previous, value));
        PubSub.publishUnsafe(subscriber.wake, undefined);
      }
    },
    close: Effect.suspend(() => {
      closed = true;
      const current = Array.from(subscribers);
      subscribers.clear();
      return Effect.forEach(current, ({ wake }) => PubSub.shutdown(wake)).pipe(Effect.asVoid);
    }),
  };
}
