// Purpose: Typed canonical thread policy failures and cause-chain lookup.
import { Data } from "effect";
export class ThreadPolicyError extends Data.TaggedError("ThreadPolicyError")<{
  readonly operation: string;
  readonly code: string;
  readonly detail: string;
  readonly cause?: unknown;
}> {
  override get message() {
    return this.detail;
  }
}
export function findThreadPolicyError(cause: unknown): ThreadPolicyError | null {
  const visited = new Set<Error>();
  let current = cause;
  while (current instanceof Error && !visited.has(current)) {
    visited.add(current);
    if (current instanceof ThreadPolicyError) return current;
    current = current.cause;
  }
  return null;
}
