import { Effect } from "effect";
import * as Semaphore from "effect/Semaphore";

/** Independent lifecycle locks, retained only while executing or queued. */
export function makeKeyedRuntimeLock<Key>() {
  const locks = new Map<Key, { semaphore: Semaphore.Semaphore; users: number }>();
  return <A, E, R>(key: Key, operation: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      let entry = locks.get(key);
      if (!entry) {
        entry = { semaphore: Semaphore.makeUnsafe(1), users: 0 };
        locks.set(key, entry);
      }
      const owned = entry;
      owned.users++;
      return owned.semaphore
        .withPermits(1)(operation)
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              owned.users--;
              if (owned.users === 0 && locks.get(key) === owned) locks.delete(key);
            }),
          ),
        );
    });
}
