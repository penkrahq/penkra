import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { qaEvidencePath, verifyQaAction } from "@penkra/shared/diagnostics/qaEvidence";
import {
  armQaRuntimeAction,
  cancelQaRuntimeAction,
  settleQaRuntimeAction,
} from "./qaRuntimeActions";

const roots: string[] = [];
afterEach(() => {
  delete process.env.PENKRA_DIAGNOSTICS_QA_PROOF_DIR;
  delete process.env.PENKRA_DIAGNOSTICS_QA_RUN_ID;
  delete process.env.PENKRA_DIAGNOSTICS_QA_SECRET;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("QA runtime action proofs", () => {
  it("waits for an applied provider lifecycle outcome on the same thread", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-qa-runtime-"));
    roots.push(dir);
    const config = {
      dir,
      runId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      secret: "ab".repeat(32),
    };
    process.env.PENKRA_DIAGNOSTICS_QA_PROOF_DIR = dir;
    process.env.PENKRA_DIAGNOSTICS_QA_RUN_ID = config.runId;
    process.env.PENKRA_DIAGNOSTICS_QA_SECRET = config.secret;
    const traceId = "0123456789abcdef0123456789abcdef";
    armQaRuntimeAction("stop", "thread-a", traceId);
    settleQaRuntimeAction({
      threadId: "thread-b",
      eventType: "turn.aborted",
      state: "interrupted",
    });
    settleQaRuntimeAction({ threadId: "thread-a", eventType: "turn.started", state: "running" });
    expect(fs.existsSync(qaEvidencePath(config))).toBe(false);
    settleQaRuntimeAction({
      threadId: "thread-a",
      eventType: "turn.aborted",
      state: "interrupted",
    });
    const rows = fs.readFileSync(qaEvidencePath(config), "utf8").trim().split("\n");
    expect(rows).toHaveLength(1);
    const proof: unknown = JSON.parse(rows[0]!);
    expect(verifyQaAction(config, proof)).toBe(true);
    expect(proof).toMatchObject({ flow: "stop", action: "turn_terminal", traceId });
  });

  it("proves play and queue only after an applied running turn, and cancels rejected commands", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-qa-runtime-"));
    roots.push(dir);
    const config = {
      dir,
      runId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
      secret: "cd".repeat(32),
    };
    process.env.PENKRA_DIAGNOSTICS_QA_PROOF_DIR = dir;
    process.env.PENKRA_DIAGNOSTICS_QA_RUN_ID = config.runId;
    process.env.PENKRA_DIAGNOSTICS_QA_SECRET = config.secret;
    const playTrace = "11111111111111111111111111111111";
    const queueTrace = "22222222222222222222222222222222";
    const cancelledTrace = "33333333333333333333333333333333";
    armQaRuntimeAction("play", "thread-play", playTrace);
    armQaRuntimeAction("queue", "thread-queue", queueTrace);
    armQaRuntimeAction("queue", "thread-cancelled", cancelledTrace);
    cancelQaRuntimeAction("queue", "thread-cancelled", cancelledTrace);
    settleQaRuntimeAction({
      threadId: "thread-play",
      eventType: "turn.completed",
      state: "ready",
    });
    expect(fs.existsSync(qaEvidencePath(config))).toBe(false);
    for (const threadId of ["thread-play", "thread-queue", "thread-cancelled"])
      settleQaRuntimeAction({ threadId, eventType: "turn.started", state: "running" });
    const proofs = fs
      .readFileSync(qaEvidencePath(config), "utf8")
      .trim()
      .split("\n")
      .map((row) => JSON.parse(row) as unknown);
    expect(proofs).toHaveLength(2);
    expect(proofs.every((proof) => verifyQaAction(config, proof))).toBe(true);
    expect(proofs).toEqual([
      expect.objectContaining({ flow: "play", traceId: playTrace }),
      expect.objectContaining({ flow: "queue", traceId: queueTrace }),
    ]);
  });
});
