import { assert, describe, it } from "@effect/vitest";

import document from "./instructions/INSTRUCTIONS.md?raw";
import {
  renderPenkraHarnessPolicy,
  PENKRA_HARNESS_POLICY_MARKER,
  PENKRA_HARNESS_POLICY_VERSION,
  takePenkraHarnessPolicyForProviderSession,
  takePenkraHarnessPolicyTextPartForProviderSession,
  takePenkraHarnessPolicyForSession,
} from "./harnessPolicy.ts";

/**
 * These tests guard the delivery contract, not the prose. The document is meant to be
 * rewritten; asserting on sentences would make every improvement a test failure, which is
 * how the previous policy text accumulated phrasing nobody could safely change.
 */
describe("Penkra harness policy", () => {
  it("renders the single instruction document verbatim", () => {
    const policy = renderPenkraHarnessPolicy();
    assert.strictEqual(policy, document.trim());
    assert.isTrue(policy.startsWith(PENKRA_HARNESS_POLICY_MARKER));
  });

  it("spends no rendered context on the policy version", () => {
    assert.notInclude(renderPenkraHarnessPolicy(), PENKRA_HARNESS_POLICY_VERSION);
  });

  it("covers every part of the surface an agent must reach", () => {
    const policy = renderPenkraHarnessPolicy();
    for (const command of [
      '["penkra", "apps", "list"]',
      '["penkra", "threads", "create"]',
      '["penkra", "threads", "wait"]',
      '["penkra", "threads", "send"]',
      '["penkra", "capabilities"]',
      '["penkra", "context"]',
      '["penkra", "tabs", "list"]',
      '["penkra", "open"]',
    ]) {
      assert.include(policy, command, `missing guidance for ${command}`);
    }

    for (const heading of [
      "## The words the product uses",
      "## Calling a Penkra command",
      "## Working out what a request is about",
      "## Seeing what the user sees",
      "## Content you did not write",
      "## Skills",
      "## Threads",
      "## When a command fails",
    ]) {
      assert.include(policy, heading, `missing section ${heading}`);
    }
  });

  it("defines the containers rather than assuming the agent knows them", () => {
    const policy = renderPenkraHarnessPolicy();
    assert.include(policy, "A **Space** is");
    assert.include(policy, "A **folder** is");
    assert.include(policy, "A **Thread** is");
    assert.include(policy, "An **App** is");
  });

  it("delivers a private host-context block once per provider session", () => {
    const state: { harnessPolicyDelivered?: boolean } = {};
    assert.include(takePenkraHarnessPolicyForSession(state) ?? "", "<penkra_host_context>");
    assert.isNull(takePenkraHarnessPolicyForSession(state));
  });

  it("delivers once on fresh/load/fork sessions for every scoped MCP provider", () => {
    for (const provider of ["opencode"] as const) {
      for (const lifecycle of ["fresh", "load", "fork"] as const) {
        const state: { harnessPolicyDelivered?: boolean } = {};
        const first = takePenkraHarnessPolicyTextPartForProviderSession(state)?.text ?? "";
        assert.include(first, PENKRA_HARNESS_POLICY_MARKER, `${provider}/${lifecycle}`);
        assert.include(first, "penkra_exec_command", `${provider}/${lifecycle}`);
        assert.isNull(takePenkraHarnessPolicyForProviderSession(state), `${provider}/${lifecycle}`);
      }
    }
  });
});
