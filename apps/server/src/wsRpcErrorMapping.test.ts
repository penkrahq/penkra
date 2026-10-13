import { describe, expect, it } from "vitest";

import { ProviderThreadSwitchCoordinatorError } from "./orchestration/Services/ProviderThreadSwitchCoordinator.ts";
import { ThreadPolicyError } from "./cleanCore/threadErrors.ts";
import { wsRpcErrorCode } from "./wsRpcErrorMapping.ts";

describe("wsRpcErrorCode", () => {
  it("maps a structured stale Play invariant to a WebSocket error code", () => {
    expect(
      wsRpcErrorCode(
        new ThreadPolicyError({
          operation: "thread.turn.recover",
          detail: "Thread changed before continuation.",
          code: "THREAD_CONTINUE_STALE",
        }),
      ),
    ).toBe("THREAD_CONTINUE_STALE");
  });
  it.each(["thread_archived", "thread_running"] as const)(
    "preserves %s through a coordinator error",
    (code) => {
      expect(
        wsRpcErrorCode(
          new ProviderThreadSwitchCoordinatorError({
            detail: "wrapped",
            cause: new ThreadPolicyError({
              operation: "thread.turn.start",
              code,
              detail: "guard",
            }),
          }),
        ),
      ).toBe(code);
    },
  );

  it("does not classify unrelated coordinator failures by message text", () => {
    expect(
      wsRpcErrorCode(
        new ProviderThreadSwitchCoordinatorError({
          detail:
            "This thread's model or Connection changed while the message was being sent. Check the thread's current settings and send again.",
        }),
      ),
    ).toBeUndefined();
  });
});
