import { describe, expect, it } from "vitest";

import { ProviderThreadSwitchCoordinatorError } from "./orchestration/Services/ProviderThreadSwitchCoordinator.ts";
import { ProviderTurnSelectionResolutionError } from "./provider/Services/ProviderTurnSelectionResolver.ts";
import { bindingRevisionErrorCode } from "./wsRpcErrorMapping.ts";

describe("bindingRevisionErrorCode", () => {
  it("preserves a stale-revision reason through the coordinator boundary", () => {
    expect(
      bindingRevisionErrorCode(
        new ProviderThreadSwitchCoordinatorError({
          detail: "selection failed",
          cause: new ProviderTurnSelectionResolutionError({
            detail: "stale",
            reason: "binding-revision-stale",
          }),
        }),
      ),
    ).toBe("THREAD_BINDING_REVISION_STALE");
  });

  it("does not classify unrelated coordinator failures by message text", () => {
    expect(
      bindingRevisionErrorCode(
        new ProviderThreadSwitchCoordinatorError({
          detail:
            "This thread's model or Connection changed while the message was being sent. Check the thread's current settings and send again.",
        }),
      ),
    ).toBeUndefined();
  });
});
