import { describe, expect, it } from "vitest";

import { findThreadGuardInvariant, OrchestrationCommandInvariantError } from "./Errors.ts";

describe("findThreadGuardInvariant", () => {
  it("terminates on a cyclic cause chain", () => {
    const cyclic = new Error("cycle");
    cyclic.cause = cyclic;
    expect(findThreadGuardInvariant(cyclic)).toBeNull();
  });

  it("still finds a guard within a cause chain", () => {
    const guard = new OrchestrationCommandInvariantError({
      commandType: "thread.turn.start",
      code: "thread_archived",
      detail: "This thread is archived. Unarchive it to send messages.",
    });
    expect(findThreadGuardInvariant(new Error("wrapped", { cause: guard }))).toBe(guard);
  });
});
