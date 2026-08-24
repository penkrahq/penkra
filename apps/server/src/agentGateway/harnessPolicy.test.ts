import { assert, describe, it } from "@effect/vitest";

import { PENKRA_HOST_POLICY_MARKER, takePenkraHostPolicyForSession } from "./harnessPolicy.ts";

describe("Penkra host-policy delivery", () => {
  it("delivers one private host-context block on fresh, load, and fork sessions", () => {
    for (const lifecycle of ["fresh", "load", "fork"] as const) {
      const state: { hostPolicyDelivered?: boolean } = {};
      const first = takePenkraHostPolicyForSession(state) ?? "";
      assert.include(first, "<penkra_host_context>", lifecycle);
      assert.include(first, PENKRA_HOST_POLICY_MARKER, lifecycle);
      assert.isNull(takePenkraHostPolicyForSession(state), lifecycle);
    }
  });
});
