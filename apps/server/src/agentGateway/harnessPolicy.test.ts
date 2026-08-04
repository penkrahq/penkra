import { assert, describe, it } from "@effect/vitest";

import {
  renderPenkraHarnessPolicy,
  PENKRA_HARNESS_POLICY_MARKER,
  takePenkraHarnessPolicyForProviderSession,
  takePenkraHarnessPolicyTextPartForProviderSession,
  takePenkraHarnessPolicyForSession,
} from "./harnessPolicy.ts";

describe("Penkra harness policy", () => {
  it("identifies Penkra and explains exact batch coordination when MCP is available", () => {
    const policy = renderPenkraHarnessPolicy({ gatewayControlAvailable: true });
    assert.include(policy, PENKRA_HARNESS_POLICY_MARKER);
    assert.include(policy, "Penkra is the host and harness");
    assert.include(policy, "one exact penkra_create_threads plan");
    assert.include(policy, "before returning an operationId");
    assert.include(policy, "penkra_wait_for_threads");
    assert.include(policy, "do not create Penkra threads");
    assert.include(policy, "3–8 word outcome-oriented task label");
    assert.include(policy, "no assumed chat context");
    assert.include(policy, "notifying the user versus staying silent");
    assert.include(policy, 'later manual follow-up such as "continue"');
    assert.include(policy, "Never call this tool for a manual follow-up turn");
  });

  it("never advertises gateway mutation to providers without scoped MCP", () => {
    const policy = renderPenkraHarnessPolicy({ gatewayControlAvailable: false });
    assert.include(policy, "Penkra MCP control is unavailable");
    assert.notInclude(policy, "one exact penkra_create_threads plan");
  });

  it("delivers a private host-context block once per provider session", () => {
    const state: { harnessPolicyDelivered?: boolean } = {};
    assert.include(
      takePenkraHarnessPolicyForSession(state, { gatewayControlAvailable: true }) ?? "",
      "<penkra_host_context>",
    );
    assert.isNull(takePenkraHarnessPolicyForSession(state, { gatewayControlAvailable: true }));
  });

  it("delivers once on fresh/load/fork sessions for every scoped MCP provider", () => {
    for (const provider of ["cursor", "grok", "droid", "opencode", "kilo", "pi"] as const) {
      for (const lifecycle of ["fresh", "load", "fork"] as const) {
        const state: { harnessPolicyDelivered?: boolean } = {};
        const first =
          takePenkraHarnessPolicyTextPartForProviderSession(state, {
            provider,
            scopedGatewayConnectionAvailable: true,
          })?.text ?? "";
        assert.include(first, PENKRA_HARNESS_POLICY_MARKER, `${provider}/${lifecycle}`);
        assert.include(first, "Use Penkra's named MCP tools", `${provider}/${lifecycle}`);
        assert.isNull(
          takePenkraHarnessPolicyForProviderSession(state, {
            provider,
            scopedGatewayConnectionAvailable: true,
          }),
          `${provider}/${lifecycle}`,
        );
      }
    }
  });

  it("keeps OpenCode, Kilo, and Pi identity-only until scoped setup succeeds", () => {
    for (const provider of ["opencode", "kilo", "pi"] as const) {
      const text =
        takePenkraHarnessPolicyForProviderSession(
          {},
          { provider, scopedGatewayConnectionAvailable: false },
        ) ?? "";
      assert.include(text, PENKRA_HARNESS_POLICY_MARKER, provider);
      assert.include(text, "Penkra MCP control is unavailable", provider);
      assert.notInclude(text, "one exact penkra_create_threads plan", provider);
    }
  });
});
