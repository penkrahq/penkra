import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
  qaEvidenceConfigFromEnv,
  qaEvidencePath,
  recordQaAction,
  signQaAction,
  verifyQaAction,
} from "./qaEvidence";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-qa-evidence-"));
const config = {
  dir: stateDir,
  runId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  secret: "ab".repeat(32),
};
const traceId = "0123456789abcdef0123456789abcdef";

afterEach(() => {
  delete process.env.PENKRA_DIAGNOSTICS_QA_PROOF_DIR;
  delete process.env.PENKRA_DIAGNOSTICS_QA_RUN_ID;
  delete process.env.PENKRA_DIAGNOSTICS_QA_SECRET;
  fs.rmSync(qaEvidencePath(config), { force: true });
});
afterAll(() => fs.rmSync(stateDir, { recursive: true, force: true }));

describe("QA app action evidence", () => {
  it("verifies only the app-signed action and matching trace", () => {
    const proof = signQaAction(config, "send", traceId);
    expect(verifyQaAction(config, proof)).toBe(true);
    expect(verifyQaAction(config, { ...proof, action: "thread_created" })).toBe(false);
    expect(verifyQaAction(config, { ...proof, traceId: "f".repeat(32) })).toBe(false);
    expect(verifyQaAction(config, { ...proof, signature: "0".repeat(64) })).toBe(false);
  });

  it("records only allowlisted action facts when QA is enabled", () => {
    expect(qaEvidenceConfigFromEnv({})).toBeNull();
    process.env.PENKRA_DIAGNOSTICS_QA_PROOF_DIR = config.dir;
    process.env.PENKRA_DIAGNOSTICS_QA_RUN_ID = config.runId;
    process.env.PENKRA_DIAGNOSTICS_QA_SECRET = config.secret;
    recordQaAction("archive", traceId);
    const content = fs.readFileSync(qaEvidencePath(config), "utf8");
    const row: unknown = JSON.parse(content.trim());
    expect(verifyQaAction(config, row)).toBe(true);
    expect(content).not.toContain(config.secret);
    expect(Object.keys(row as object).sort()).toEqual([
      "action",
      "at",
      "flow",
      "runId",
      "signature",
      "traceId",
      "version",
    ]);
  });
});
