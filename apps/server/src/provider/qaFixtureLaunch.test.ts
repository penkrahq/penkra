import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { qaFixtureLaunchAllowed } from "./qaFixtureLaunch";

describe("qaFixtureLaunchAllowed", () => {
  it("requires a test build and exact disposable Dev profile", () => {
    const temp = fs.mkdtempSync("/tmp/penkra-diagnostics-qa-0143.");
    const root = path.join(temp, "root");
    const stateDir = path.join(root, ".penkra", "dev");
    const proofDir = path.join(temp, "proofs");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(proofDir);
    const env = {
      PENKRA_DESKTOP_FLAVOR: "development",
      PENKRA_DIAGNOSTICS_QA_PROVIDER_SOURCE: "scripted-fixture",
      PENKRA_DIAGNOSTICS_QA_RUN_ID: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      PENKRA_DIAGNOSTICS_QA_SECRET: "ab".repeat(32),
      PENKRA_DIAGNOSTICS_QA_PROOF_DIR: proofDir,
      PENKRA_ROOT: root,
    };
    try {
      expect(qaFixtureLaunchAllowed({ buildEnabled: true, stateDir, env })).toBe(true);
      expect(qaFixtureLaunchAllowed({ buildEnabled: false, stateDir, env })).toBe(false);
      expect(
        qaFixtureLaunchAllowed({
          buildEnabled: true,
          stateDir,
          env: { ...env, PENKRA_DESKTOP_FLAVOR: "production" },
        }),
      ).toBe(false);
      expect(
        qaFixtureLaunchAllowed({
          buildEnabled: true,
          stateDir,
          env: { ...env, PENKRA_ROOT: "/Applications/Penkra.app" },
        }),
      ).toBe(false);
      expect(
        qaFixtureLaunchAllowed({ buildEnabled: true, stateDir: path.dirname(stateDir), env }),
      ).toBe(false);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
