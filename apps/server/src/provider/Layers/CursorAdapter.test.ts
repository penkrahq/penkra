// FILE: CursorAdapter.test.ts
// Purpose: Characterizes Cursor's private Penkra host-policy delivery.
// Layer: Provider adapter tests

import { PENKRA_HARNESS_POLICY_MARKER } from "../../agentGateway/harnessPolicy.ts";
import { describe, expect, it } from "vitest";

import { takeCursorPenkraHarnessPolicyTextPart } from "./CursorAdapter.ts";

describe("Cursor Penkra harness policy", () => {
  it("delivers scoped MCP host context exactly once per fresh/load/fork session", () => {
    for (const lifecycle of ["fresh", "load", "fork"] as const) {
      const state: { harnessPolicyDelivered?: boolean } = {};
      const first = takeCursorPenkraHarnessPolicyTextPart(state, true);
      expect(first?.text, lifecycle).toContain(PENKRA_HARNESS_POLICY_MARKER);
      expect(first?.text, lifecycle).toContain(
        "Use `penkra_exec_command` for every Penkra operation",
      );
      expect(takeCursorPenkraHarnessPolicyTextPart(state, true), lifecycle).toBeNull();
    }
  });

  it("stays truthful without a scoped gateway connection", () => {
    expect(takeCursorPenkraHarnessPolicyTextPart({}, false)?.text).toContain(
      "Penkra MCP control is unavailable",
    );
  });
});
