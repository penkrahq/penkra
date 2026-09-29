import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { qaEvidencePath, writeQaChallenge } from "@penkra/shared/diagnostics/qaEvidence";
import { recordServerQaAction, serverQaProofConfig } from "./qaProofBuild";

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.PENKRA_DIAGNOSTICS_QA_PROOF_DIR;
  delete process.env.PENKRA_DIAGNOSTICS_QA_RUN_ID;
  delete process.env.PENKRA_DIAGNOSTICS_QA_SECRET;
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("server QA proof build gate", () => {
  it("ignores inherited proof credentials without the compiled QA flag", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-qa-proof-build-"));
    directories.push(dir);
    const config = {
      dir,
      runId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      secret: "ab".repeat(32),
    };
    process.env.PENKRA_DIAGNOSTICS_QA_PROOF_DIR = dir;
    process.env.PENKRA_DIAGNOSTICS_QA_RUN_ID = config.runId;
    process.env.PENKRA_DIAGNOSTICS_QA_SECRET = config.secret;
    writeQaChallenge(config, "send", "cd".repeat(32));
    expect(serverQaProofConfig()).toBeNull();
    recordServerQaAction("send", "01".repeat(16));
    expect(fs.existsSync(qaEvidencePath(config))).toBe(false);
    vi.stubGlobal("__PENKRA_DIAGNOSTICS_QA_PROOF_BUILD__", true);
    expect(serverQaProofConfig()).toEqual(config);
    recordServerQaAction("send", "01".repeat(16));
    expect(fs.existsSync(qaEvidencePath(config))).toBe(true);
  });
});
