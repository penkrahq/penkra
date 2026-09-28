import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DiagnosticsStore } from "@penkra/shared/diagnostics/store";
import { describe, expect, it } from "vitest";

import {
  evaluateDiagnosticsQaGate,
  REQUIRED_QA_FLOWS,
  runDiagnosticsQaGate,
} from "./diagnostics-qa-gate";

describe("diagnostics clean QA gate", () => {
  it("fails on a repeated aggregate occurrence or a failed required script", () => {
    const results = REQUIRED_QA_FLOWS.map((flow) => ({ flow, passed: flow !== "play" }));
    expect(
      evaluateDiagnosticsQaGate(new Set(["old"]), new Set(["old", "repeat"]), results),
    ).toEqual({
      passed: false,
      failedFlows: ["play"],
      newIncidentIds: ["repeat"],
      pendingExpectations: 0,
      pendingSpools: 0,
      storeReset: false,
      newLosses: 0,
    });
  });

  it("requires every script to pass and zero new occurrences", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-qa-gate-"));
    try {
      const store = new DiagnosticsStore({ stateDir, appVersion: "0.14.3", process: "server" });
      const scripts = new Map(
        REQUIRED_QA_FLOWS.map((flow) => {
          const script = path.join(stateDir, `${flow}.ts`);
          fs.writeFileSync(script, "// scripted flow fixture\n");
          return [flow, script] as const;
        }),
      );
      expect(() =>
        runDiagnosticsQaGate(
          stateDir,
          new Map(REQUIRED_QA_FLOWS.map((flow) => [flow, scripts.get("send")!])),
          () => true,
        ),
      ).toThrow("distinct script");
      expect(runDiagnosticsQaGate(stateDir, scripts, () => true)).toEqual({
        passed: true,
        failedFlows: [],
        newIncidentIds: [],
        pendingExpectations: 0,
        pendingSpools: 0,
        storeReset: false,
        newLosses: 0,
      });
      let calls = 0;
      const failure = runDiagnosticsQaGate(stateDir, scripts, () => {
        if (++calls === 2)
          store.incident({
            traceId: "0123456789abcdef0123456789abcdef",
            spanId: "0123456789abcdef",
            kind: "command.failed",
            code: "COMMAND_REJECTED",
            where: "server.command",
            severity: "error",
          });
        return true;
      });
      expect(failure.passed).toBe(false);
      expect(failure.newIncidentIds).toHaveLength(1);
      const spool = path.join(
        stateDir,
        "diagnostics",
        "spool-0123456789abcdef0123456789abcdef.jsonl",
      );
      fs.writeFileSync(spool, "pending\n");
      const pending = runDiagnosticsQaGate(stateDir, scripts, () => true);
      expect(pending.passed).toBe(false);
      expect(pending.pendingSpools).toBe(1);
      fs.rmSync(spool);
      const expectationId = store.armExpectation({
        traceId: "0123456789abcdef0123456789abcdef",
        spanId: "0123456789abcdef",
        kind: "turn.started",
        deadlineMs: 60_000,
      });
      const awaiting = runDiagnosticsQaGate(stateDir, scripts, () => true);
      expect(awaiting.passed).toBe(false);
      expect(awaiting.pendingExpectations).toBe(1);
      store.resolveExpectation(expectationId, "cancelled");
      const ledger = path.join(
        stateDir,
        "diagnostics",
        "loss-0123456789abcdef0123456789abcdef.bin",
      );
      let runs = 0;
      const lost = runDiagnosticsQaGate(stateDir, scripts, () => {
        if (++runs === 1)
          fs.writeFileSync(
            ledger,
            JSON.stringify({
              count: 1,
              reason: "spool",
              reasons: { capacity: 0, sqlite: 0, spool: 1, stale: 0 },
            }).padEnd(512),
          );
        return true;
      });
      expect(lost.passed).toBe(false);
      expect(lost.newLosses).toBe(1);
      fs.rmSync(ledger);
      const databasePath = path.join(stateDir, "diagnostics", "diagnostics.sqlite");
      runs = 0;
      const anomaly = runDiagnosticsQaGate(stateDir, scripts, () => {
        if (++runs === 1) {
          const db = new DatabaseSync(databasePath);
          db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)").run(
            "spool-invalid:0123456789abcdef0123456789abcdef",
            "1",
          );
          db.close();
        }
        return true;
      });
      expect(anomaly.passed).toBe(false);
      expect(anomaly.newLosses).toBe(1);
      const identityPath = path.join(stateDir, "diagnostics", "identity");
      const identity = fs.readFileSync(identityPath, "utf8");
      runs = 0;
      const reset = runDiagnosticsQaGate(stateDir, scripts, () => {
        if (++runs === 1) fs.writeFileSync(identityPath, "new-build-identity");
        return true;
      });
      expect(reset.passed).toBe(false);
      expect(reset.storeReset).toBe(true);
      fs.writeFileSync(identityPath, identity);
      store.close();
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
