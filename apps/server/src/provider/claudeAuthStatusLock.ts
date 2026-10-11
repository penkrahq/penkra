// FILE: claudeAuthStatusLock.ts
// Purpose: Serialize every `claude auth status` invocation across this process.
// Layer: Provider utility (dependency-free, in-process only).
// Exports: acquireClaudeAuthStatusLock()
//
// Why this exists
// ----------------
// `claude auth status` can redeem a single-use rotating OAuth refresh token when the
// stored access token is at/near expiry. Concurrent provider-health probes must
// not redeem the same token: the loser would report `{"loggedIn":false}` after
// the other probe rotates it. This FIFO mutex serializes those invocations.
//
// The dependency-free promise chain holds the lock until the command completes.

let tail: Promise<unknown> = Promise.resolve();

/**
 * Acquire the lock, resolving once it is this caller's turn. Callers MUST invoke the
 * returned release function exactly once when done (though calling it more than once is
 * harmless) so the next queued acquirer can proceed.
 */
export function acquireClaudeAuthStatusLock(): Promise<() => void> {
  const previousTail = tail;

  let resolveHeld: () => void;
  const held = new Promise<void>((resolve) => {
    resolveHeld = resolve;
  });

  // Advance the shared tail immediately so any acquirer registered after this call
  // waits for both everyone ahead of it AND this holder's eventual release.
  tail = previousTail.then(() => held);

  return previousTail.then(() => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      resolveHeld();
    };
  });
}
