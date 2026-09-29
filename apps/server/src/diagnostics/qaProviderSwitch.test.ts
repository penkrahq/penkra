import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  qaEvidencePath,
  verifyQaAction,
  writeQaChallenge,
} from "@penkra/shared/diagnostics/qaEvidence";
import {
  armQaProviderSwitch,
  clearQaProviderSwitch,
  committedQaProviderSwitch,
  requestedQaProviderSwitch,
} from "./qaProviderSwitch";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-qa-provider-switch-"));
const config = {
  dir,
  runId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  secret: "ab".repeat(32),
};
const traceId = "1".repeat(32);
const spanId = "2".repeat(16);
const challenge = "3".repeat(64);

afterEach(() => {
  delete process.env.PENKRA_DIAGNOSTICS_QA_PROOF_DIR;
  delete process.env.PENKRA_DIAGNOSTICS_QA_RUN_ID;
  delete process.env.PENKRA_DIAGNOSTICS_QA_SECRET;
  fs.rmSync(qaEvidencePath(config), { force: true });
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("provider-switch QA proof", () => {
  it("requires the exact command's durable request and commit", async () => {
    process.env.PENKRA_DIAGNOSTICS_QA_PROOF_DIR = dir;
    process.env.PENKRA_DIAGNOSTICS_QA_RUN_ID = config.runId;
    process.env.PENKRA_DIAGNOSTICS_QA_SECRET = config.secret;
    writeQaChallenge(config, "provider-switch", challenge);
    armQaProviderSwitch("command-a", "thread-a", traceId, spanId);
    committedQaProviderSwitch("command-a", "thread-a");
    requestedQaProviderSwitch("command-a", "thread-b");
    expect(fs.existsSync(qaEvidencePath(config))).toBe(false);
    requestedQaProviderSwitch("command-a", "thread-a");
    committedQaProviderSwitch("command-b", "thread-a");
    expect(fs.existsSync(qaEvidencePath(config))).toBe(false);
    committedQaProviderSwitch("command-a", "thread-a");
    for (let i = 0; i < 50 && !fs.existsSync(qaEvidencePath(config)); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const rows = fs.readFileSync(qaEvidencePath(config), "utf8").trim().split("\n");
    expect(rows).toHaveLength(1);
    expect(verifyQaAction(config, JSON.parse(rows[0]!), challenge)).toBe(true);
    clearQaProviderSwitch("command-a");
  });
});
