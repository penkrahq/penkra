import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { qaEvidencePath, verifyQaAction } from "@penkra/shared/diagnostics/qaEvidence";
import { armQaRuntimeAction, settleQaRuntimeAction } from "./qaRuntimeActions";

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
    settleQaRuntimeAction({
      threadId: "thread-a",
      logicalTurnId: "turn-a",
      eventType: "turn.aborted",
      state: "interrupted",
    });
    expect(fs.existsSync(qaEvidencePath(config))).toBe(false);
    armQaRuntimeAction("stop", "thread-a", "turn-a", traceId);
    settleQaRuntimeAction({
      threadId: "thread-b",
      logicalTurnId: "turn-a",
      eventType: "turn.aborted",
      state: "interrupted",
    });
    settleQaRuntimeAction({
      threadId: "thread-a",
      logicalTurnId: null,
      eventType: "turn.aborted",
      state: "interrupted",
    });
    settleQaRuntimeAction({
      threadId: "thread-a",
      logicalTurnId: "turn-b",
      eventType: "turn.aborted",
      state: "interrupted",
    });
    settleQaRuntimeAction({
      threadId: "thread-a",
      logicalTurnId: "turn-a",
      eventType: "turn.started",
      state: "running",
    });
    expect(fs.existsSync(qaEvidencePath(config))).toBe(false);
    settleQaRuntimeAction({
      threadId: "thread-a",
      logicalTurnId: "turn-a",
      eventType: "turn.aborted",
      state: "interrupted",
    });
    const rows = fs.readFileSync(qaEvidencePath(config), "utf8").trim().split("\n");
    expect(rows).toHaveLength(1);
    const proof: unknown = JSON.parse(rows[0]!);
    expect(verifyQaAction(config, proof)).toBe(true);
    expect(proof).toMatchObject({ flow: "stop", action: "turn_terminal", traceId });
  });

  it("proves play and queue only after the matching logical turn is running", () => {
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
    armQaRuntimeAction("play", "thread-play", "turn-play", playTrace);
    armQaRuntimeAction("queue", "thread-queue", "turn-queue", queueTrace);
    settleQaRuntimeAction({
      threadId: "thread-play",
      logicalTurnId: "turn-play",
      eventType: "turn.completed",
      state: "ready",
    });
    expect(fs.existsSync(qaEvidencePath(config))).toBe(false);
    settleQaRuntimeAction({
      threadId: "thread-queue",
      logicalTurnId: "turn-other",
      eventType: "turn.started",
      state: "running",
    });
    expect(fs.existsSync(qaEvidencePath(config))).toBe(false);
    settleQaRuntimeAction({
      threadId: "thread-play",
      logicalTurnId: "turn-play",
      eventType: "turn.started",
      state: "running",
    });
    settleQaRuntimeAction({
      threadId: "thread-queue",
      logicalTurnId: "turn-queue",
      eventType: "turn.started",
      state: "running",
    });
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
