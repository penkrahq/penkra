import { describe, expect, it } from "vitest";

import { findThreadPolicyError, ThreadPolicyError } from "./threadErrors.ts";

describe("findThreadPolicyError", () => {
  it("terminates on a cyclic cause chain", () => {
    const cyclic = new Error("cycle");
    cyclic.cause = cyclic;
    expect(findThreadPolicyError(cyclic)).toBeNull();
  });

  it("still finds a guard within a cause chain", () => {
    const guard = new ThreadPolicyError({
      operation: "thread.turn.start",
      code: "thread_archived",
      detail: "This thread is archived. Unarchive it to send messages.",
    });
    expect(findThreadPolicyError(new Error("wrapped", { cause: guard }))).toBe(guard);
  });
});
