import { Cause, Effect } from "effect";

/**
 * One failed commit must not end a provider's event stream: that silently stops
 * every thread on the provider.
 *
 * - A full disk is transient and the user can fix it, and the events being
 *   committed include turn endings. Dropping them would leave a thread "working"
 *   forever, so the consumer pauses and retries until space returns, then catches
 *   up in order. Nothing is lost.
 * - Any other failure is retried a few times with backoff, then the event is
 *   dropped with a logged error so one poison event cannot block every thread.
 */
export const COMMIT_RETRY_DELAYS_MS: ReadonlyArray<number> = [250, 1_000, 4_000];
export const DISK_FULL_RETRY_MS = 5_000;

const DISK_FULL = /database or disk is full|SQLITE_FULL|ENOSPC|no space left on device/i;

export const isDiskFullCause = (cause: Cause.Cause<unknown>): boolean =>
  DISK_FULL.test(Cause.pretty(cause));

export const guardCommit = <A>(
  description: { readonly eventType: string; readonly threadIds: ReadonlyArray<string> },
  commit: Effect.Effect<A, unknown>,
  delaysMs: ReadonlyArray<number> = COMMIT_RETRY_DELAYS_MS,
  diskFullRetryMs: number = DISK_FULL_RETRY_MS,
): Effect.Effect<A | undefined> => {
  const attempt = (retry: number, diskFullWaits: number): Effect.Effect<A | undefined> =>
    commit.pipe(
      Effect.catchCause((cause): Effect.Effect<A | undefined> => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
        if (isDiskFullCause(cause)) {
          const log = { ...description, waits: diskFullWaits + 1, cause: Cause.pretty(cause) };
          // Log the first wait and then once a minute; the wait itself is silent.
          return (
            diskFullWaits % Math.max(1, Math.round(60_000 / diskFullRetryMs)) === 0
              ? Effect.logWarning("provider.runtime-event.waiting-for-disk-space", log)
              : Effect.void
          ).pipe(
            Effect.andThen(Effect.sleep(diskFullRetryMs)),
            Effect.andThen(attempt(retry, diskFullWaits + 1)),
          );
        }
        const delay = delaysMs[retry];
        const log = { ...description, attempt: retry + 1, cause: Cause.pretty(cause) };
        return delay === undefined
          ? Effect.logError("provider.runtime-event.commit-dropped", log).pipe(Effect.as(undefined))
          : Effect.logWarning("provider.runtime-event.commit-retrying", log).pipe(
              Effect.andThen(Effect.sleep(delay)),
              Effect.andThen(attempt(retry + 1, diskFullWaits)),
            );
      }),
    );
  return attempt(0, 0);
};
