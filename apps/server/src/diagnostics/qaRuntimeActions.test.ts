import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  qaEvidencePath,
  verifyQaAction,
  writeQaChallenge,
} from "@penkra/shared/diagnostics/qaEvidence";
import {
  admitQaRuntimeAction,
  armQaRuntimeAction,
  clearQaRuntimeAction,
  prepareQaRuntimeAction,
  settleQaRuntimeAction,
  shouldObserveQaLifecycle,
} from "./qaRuntimeActions";
import { installDiagnosticsStore } from "./recorder";
import type { DiagnosticsStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  delete process.env.PENKRA_DIAGNOSTICS_QA_PROOF_DIR;
  delete process.env.PENKRA_DIAGNOSTICS_QA_RUN_ID;
  delete process.env.PENKRA_DIAGNOSTICS_QA_SECRET;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("QA runtime action proofs", () => {
  it("recognizes an exact terminal already projected by interrupt admission", () => {
    expect(
      shouldObserveQaLifecycle({
        eventType: "turn.completed",
        state: "interrupted",
        shouldApply: false,
        disposition: "skipped",
        projectedTurnState: "interrupted",
      }),
    ).toBe(true);
    expect(
      shouldObserveQaLifecycle({
        eventType: "turn.completed",
        state: "interrupted",
        shouldApply: false,
        disposition: "skipped",
        projectedTurnState: "running",
      }),
    ).toBe(true);
    expect(
      shouldObserveQaLifecycle({
        eventType: "turn.completed",
        state: "interrupted",
        shouldApply: false,
        disposition: "skipped",
        projectedTurnState: null,
      }),
    ).toBe(false);
    expect(
      shouldObserveQaLifecycle({
        eventType: "turn.started",
        state: "running",
        shouldApply: false,
        disposition: "skipped",
        projectedTurnState: "running",
      }),
    ).toBe(false);
  });

  it("holds a fast lifecycle event until durable admission and discards rejected commands", () => {
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
    writeQaChallenge(config, "play", "04".repeat(32));
    const traceId = "0123456789abcdef0123456789abcdef";
    prepareQaRuntimeAction("play", "fast-thread", "fast-turn", traceId);
    settleQaRuntimeAction({
      threadId: "fast-thread",
      logicalTurnId: "fast-turn",
      eventType: "turn.started",
      state: "running",
    });
    expect(fs.existsSync(qaEvidencePath(config))).toBe(false);
    admitQaRuntimeAction("play", "fast-thread", "fast-turn", traceId);
    expect(
      verifyQaAction(config, JSON.parse(fs.readFileSync(qaEvidencePath(config), "utf8"))),
    ).toBe(true);
    prepareQaRuntimeAction("play", "rejected-thread", "rejected-turn", traceId);
    settleQaRuntimeAction({
      threadId: "rejected-thread",
      logicalTurnId: "rejected-turn",
      eventType: "turn.started",
      state: "running",
    });
    clearQaRuntimeAction("play", "rejected-thread", "rejected-turn", traceId);
    admitQaRuntimeAction("play", "rejected-thread", "rejected-turn", traceId);
    expect(fs.readFileSync(qaEvidencePath(config), "utf8").trim().split("\n")).toHaveLength(1);
  });

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
    writeQaChallenge(config, "stop", "01".repeat(32));
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
    writeQaChallenge(config, "play", "02".repeat(32));
    writeQaChallenge(config, "queue", "03".repeat(32));
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

  it("records the applied lifecycle checkpoint on the admitted command trace", () => {
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
    writeQaChallenge(config, "stop", "01".repeat(32));
    const checkpoints: unknown[] = [];
    const uninstall = installDiagnosticsStore({
      startHealthSampling: () => () => {},
      startProcessWatchdog: () => () => {},
      checkpoint: (input: unknown) => checkpoints.push(input),
    } as unknown as DiagnosticsStore);
    try {
      prepareQaRuntimeAction("stop", "thread-a", "native-turn-a", "1".repeat(32), "2".repeat(16));
      settleQaRuntimeAction({
        threadId: "thread-a",
        logicalTurnId: "logical-turn-a",
        nativeTurnId: "native-turn-a",
        eventType: "turn.completed",
        state: "interrupted",
      });
      expect(checkpoints).toEqual([]);
      admitQaRuntimeAction("stop", "thread-a", "native-turn-a", "1".repeat(32));
      expect(checkpoints).toEqual([
        expect.objectContaining({
          traceId: "1".repeat(32),
          spanId: "2".repeat(16),
          threadId: "thread-a",
          flow: "stop",
          step: "turn.terminal",
          outcome: "ok",
        }),
      ]);
    } finally {
      uninstall();
    }
  });
});
