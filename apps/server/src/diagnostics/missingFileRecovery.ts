import { Effect } from "effect";

/** Effect FileSystem represents ENOENT as NotFound; Node adapters use code. */
export function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (("code" in error && error.code === "ENOENT") ||
      ("reason" in error &&
        typeof error.reason === "object" &&
        error.reason !== null &&
        "_tag" in error.reason &&
        error.reason._tag === "NotFound"))
  );
}

export function recoverMissingFile<A, E, R>(
  operation: Effect.Effect<A, E, R>,
  recordUnexpected: () => void,
): Effect.Effect<A | null, E, R> {
  return operation.pipe(
    Effect.catch((error) => {
      if (isMissingFileError(error)) return Effect.succeed(null);
      recordUnexpected();
      return Effect.fail(error);
    }),
  );
}
