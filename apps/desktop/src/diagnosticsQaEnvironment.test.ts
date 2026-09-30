import { describe, expect, it } from "vitest";
import { stripPackagedDiagnosticsQaEnvironment } from "./diagnosticsQaEnvironment";

describe("packaged backend environment", () => {
  it("removes every diagnostics QA variable without changing normal backend values", () => {
    const inherited = {
      PENKRA_DIAGNOSTICS_QA_PROOF_DIR: "/tmp/proofs",
      PENKRA_DIAGNOSTICS_QA_RUN_ID: "run",
      PENKRA_DIAGNOSTICS_QA_SECRET: "secret",
      PENKRA_DIAGNOSTICS_QA_PROVIDER_SOURCE: "scripted-fixture",
      PENKRA_HOME: "/tmp/home",
    };
    expect(stripPackagedDiagnosticsQaEnvironment(inherited, true)).toEqual({
      PENKRA_HOME: "/tmp/home",
    });
    expect(stripPackagedDiagnosticsQaEnvironment(inherited, false)).toEqual(inherited);
  });
});
