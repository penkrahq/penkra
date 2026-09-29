import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DiagnosticsStore } from "@penkra/shared/diagnostics/store";
import {
  qaEvidencePath,
  signQaAction,
  type QaEvidenceConfig,
} from "@penkra/shared/diagnostics/qaEvidence";
import { describe, expect, it } from "vitest";

import {
  DIAGNOSTIC_FLOW,
  evaluateDiagnosticsQaGate,
  REQUIRED_QA_CHECKS,
  REQUIRED_QA_FLOWS,
  runDiagnosticsQaGate,
  type QaFlow,
  type QaFlowResult,
} from "./diagnostics-qa-gate";

const passing = (_script: string, _stateDir: string, flow: QaFlow) => ({
  flow,
  passed: true,
  checks: REQUIRED_QA_CHECKS[flow],
});

const qaConfig = (stateDir: string): QaEvidenceConfig => ({
  dir: path.join(stateDir, "qa-proofs"),
  runId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  secret: "ab".repeat(32),
});

const runGate = (
  stateDir: string,
  scripts: ReadonlyMap<QaFlow, string>,
  runner?: (script: string, stateDir: string, flow: QaFlow) => QaFlowResult,
) => runDiagnosticsQaGate(stateDir, scripts, runner, qaConfig(stateDir));

let nextTrace = 0;
function withObservedChecks(
  store: DiagnosticsStore,
  report: (script: string, stateDir: string, flow: QaFlow) => QaFlowResult = passing,
) {
  return (script: string, stateDir: string, flow: QaFlow): QaFlowResult => {
    const traceId = (++nextTrace).toString(16).padStart(32, "0");
    for (const step of REQUIRED_QA_CHECKS[flow])
      store.checkpoint({
        traceId,
        spanId: "0123456789abcdef",
        flow: DIAGNOSTIC_FLOW[flow],
        step,
        outcome: "ok",
      });
    const config = qaConfig(stateDir);
    fs.mkdirSync(config.dir, { recursive: true });
    fs.appendFileSync(
      qaEvidencePath(config),
      `${JSON.stringify(signQaAction(config, flow, traceId))}\n`,
    );
    return report(script, stateDir, flow);
  };
}

describe("diagnostics clean QA gate", () => {
  it("fails on a repeated aggregate occurrence or a failed required script", () => {
    const results = REQUIRED_QA_FLOWS.map((flow) => ({
      flow,
      passed: flow !== "play",
      checks: REQUIRED_QA_CHECKS[flow],
    }));
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
      possiblyLost: 0,
      lostCountUnknown: 0,
      exactOverflow: 0,
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
      const trusted = withObservedChecks(store);
      expect(() =>
        runGate(
          stateDir,
          new Map(REQUIRED_QA_FLOWS.map((flow) => [flow, scripts.get("send")!])),
          trusted,
        ),
      ).toThrow("distinct script");
      expect(runGate(stateDir, scripts, trusted)).toEqual({
        passed: true,
        failedFlows: [],
        newIncidentIds: [],
        pendingExpectations: 0,
        pendingSpools: 0,
        storeReset: false,
        newLosses: 0,
        possiblyLost: 0,
        lostCountUnknown: 0,
        exactOverflow: 0,
      });
      expect(runGate(stateDir, scripts).failedFlows).toEqual([...REQUIRED_QA_FLOWS]);
      expect(
        runGate(
          stateDir,
          scripts,
          withObservedChecks(store, (script, dir, flow) =>
            flow === "stop" ? passing(script, dir, "send") : passing(script, dir, flow),
          ),
        ).failedFlows,
      ).toEqual(["send", "stop"]);
      expect(
        runGate(
          stateDir,
          scripts,
          withObservedChecks(store, (script, dir, flow) =>
            flow === "play"
              ? { ...passing(script, dir, flow), checks: [] }
              : passing(script, dir, flow),
          ),
        ).failedFlows,
      ).toEqual([]);
      let calls = 0;
      const failure = runGate(
        stateDir,
        scripts,
        withObservedChecks(store, (script, dir, flow) => {
          if (++calls === 2)
            store.incident({
              traceId: "0123456789abcdef0123456789abcdef",
              spanId: "0123456789abcdef",
              kind: "command.failed",
              code: "COMMAND_REJECTED",
              where: "server.command",
              severity: "error",
            });
          return passing(script, dir, flow);
        }),
      );
      expect(failure.passed).toBe(false);
      expect(failure.newIncidentIds).toHaveLength(1);
      const spool = path.join(
        stateDir,
        "diagnostics",
        "spool-0123456789abcdef0123456789abcdef.jsonl",
      );
      fs.writeFileSync(spool, "pending\n");
      const pending = runGate(stateDir, scripts, trusted);
      expect(pending.passed).toBe(false);
      expect(pending.pendingSpools).toBe(1);
      fs.rmSync(spool);
      const expectationId = store.armExpectation({
        traceId: "0123456789abcdef0123456789abcdef",
        spanId: "0123456789abcdef",
        kind: "turn.started",
        deadlineMs: 60_000,
      });
      const awaiting = runGate(stateDir, scripts, trusted);
      expect(awaiting.passed).toBe(false);
      expect(awaiting.pendingExpectations).toBe(1);
      store.resolveExpectation(expectationId, "cancelled");
      const ledger = path.join(
        stateDir,
        "diagnostics",
        "loss-0123456789abcdef0123456789abcdef.bin",
      );
      let runs = 0;
      const lost = runGate(
        stateDir,
        scripts,
        withObservedChecks(store, (script, dir, flow) => {
          if (++runs === 1)
            fs.writeFileSync(
              ledger,
              JSON.stringify({
                count: 1,
                reason: "spool",
                reasons: { capacity: 0, sqlite: 0, spool: 1, stale: 0 },
              }).padEnd(256),
            );
          return passing(script, dir, flow);
        }),
      );
      expect(lost.passed).toBe(false);
      expect(lost.newLosses).toBe(1);
      fs.rmSync(ledger);
      const databasePath = path.join(stateDir, "diagnostics", "diagnostics.sqlite");
      runs = 0;
      const anomaly = runGate(
        stateDir,
        scripts,
        withObservedChecks(store, (script, dir, flow) => {
          if (++runs === 1) {
            const db = new DatabaseSync(databasePath);
            db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)").run(
              "spool-invalid:0123456789abcdef0123456789abcdef",
              "1",
            );
            db.close();
          }
          return passing(script, dir, flow);
        }),
      );
      expect(anomaly.passed).toBe(false);
      expect(anomaly.newLosses).toBe(1);
      runs = 0;
      const evicted = runGate(
        stateDir,
        scripts,
        withObservedChecks(store, (script, dir, flow) => {
          if (++runs === 1) {
            const db = new DatabaseSync(databasePath);
            db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)").run("incident_evictions", "1");
            db.close();
          }
          return passing(script, dir, flow);
        }),
      );
      expect(evicted.passed).toBe(false);
      expect(evicted.newLosses).toBe(1);
      runs = 0;
      const creditLoss = runGate(
        stateDir,
        scripts,
        withObservedChecks(store, (script, dir, flow) => {
          if (++runs === 1) {
            const db = new DatabaseSync(databasePath);
            db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)").run("possibly-lost:boot", "2");
            db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)").run(
              "lost-count-unknown:boot",
              "1",
            );
            db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)").run(
              "worker-overflow:boot",
              "3",
            );
            db.close();
          }
          return passing(script, dir, flow);
        }),
      );
      expect(creditLoss.passed).toBe(false);
      expect(creditLoss.possiblyLost).toBe(2);
      expect(creditLoss.lostCountUnknown).toBe(1);
      expect(creditLoss.exactOverflow).toBe(3);
      const identityPath = path.join(stateDir, "diagnostics", "identity");
      const identity = fs.readFileSync(identityPath, "utf8");
      runs = 0;
      const reset = runGate(stateDir, scripts, (script, dir, flow) => {
        if (++runs === 1) fs.writeFileSync(identityPath, "new-build-identity");
        return passing(script, dir, flow);
      });
      expect(reset.passed).toBe(false);
      expect(reset.storeReset).toBe(true);
      fs.writeFileSync(identityPath, identity);
      store.close();
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("detects a same-identity reset with an empty incident baseline", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-qa-reset-"));
    try {
      const store = new DiagnosticsStore({ stateDir, appVersion: "0.14.3", process: "server" });
      const scripts = new Map(
        REQUIRED_QA_FLOWS.map((flow) => {
          const script = path.join(stateDir, `${flow}.js`);
          fs.writeFileSync(script, "// flow fixture\n");
          return [flow, script] as const;
        }),
      );
      const dbPath = path.join(stateDir, "diagnostics", "diagnostics.sqlite");
      let changed = false;
      const result = runGate(stateDir, scripts, (script, dir, flow) => {
        if (!changed) {
          changed = true;
          const db = new DatabaseSync(dbPath);
          db.prepare("UPDATE meta SET value = ? WHERE key = 'reset_id'").run(
            "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          );
          db.close();
        }
        return passing(script, dir, flow);
      });
      expect(result.storeReset).toBe(true);
      expect(result.newIncidentIds).toEqual([]);
      expect(result.passed).toBe(false);
      store.close();
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects hard-coded successful reports without fresh app observations", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-qa-proofs-"));
    try {
      const store = new DiagnosticsStore({ stateDir, appVersion: "0.14.3", process: "server" });
      const scripts = new Map(
        REQUIRED_QA_FLOWS.map((flow) => {
          const script = path.join(stateDir, `${flow}.mjs`);
          fs.writeFileSync(
            script,
            `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.PENKRA_DIAGNOSTICS_QA_REPORT_PATH, ${JSON.stringify(JSON.stringify(passing(script, stateDir, flow)))});\n`,
          );
          return [flow, script] as const;
        }),
      );
      const seedOldObservations = withObservedChecks(store);
      for (const flow of REQUIRED_QA_FLOWS) seedOldObservations("", stateDir, flow);
      expect(runGate(stateDir, scripts).failedFlows).toEqual([...REQUIRED_QA_FLOWS]);
      store.close();
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects forged fresh checkpoints without an app-signed action result", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-qa-forged-"));
    try {
      const store = new DiagnosticsStore({ stateDir, appVersion: "0.14.3", process: "server" });
      const scripts = new Map(
        REQUIRED_QA_FLOWS.map((flow) => {
          const script = path.join(stateDir, `${flow}.mjs`);
          fs.writeFileSync(script, "// forged checkpoint fixture\n");
          return [flow, script] as const;
        }),
      );
      const result = runGate(stateDir, scripts, (script, _dir, flow) => {
        const traceId = (++nextTrace).toString(16).padStart(32, "0");
        for (const step of REQUIRED_QA_CHECKS[flow])
          store.checkpoint({
            traceId,
            spanId: "0123456789abcdef",
            flow: DIAGNOSTIC_FLOW[flow],
            step,
            outcome: "ok",
          });
        return passing(script, stateDir, flow);
      });
      expect(result.failedFlows).toEqual([...REQUIRED_QA_FLOWS]);
      store.close();
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("requires both successful observations on one fresh trace", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-qa-trace-"));
    try {
      const store = new DiagnosticsStore({ stateDir, appVersion: "0.14.3", process: "server" });
      const scripts = new Map(
        REQUIRED_QA_FLOWS.map((flow) => {
          const script = path.join(stateDir, `${flow}.ts`);
          fs.writeFileSync(script, "// flow fixture\n");
          return [flow, script] as const;
        }),
      );
      const result = runGate(stateDir, scripts, (script, dir, flow) => {
        for (const step of REQUIRED_QA_CHECKS[flow])
          store.checkpoint({
            traceId: (++nextTrace).toString(16).padStart(32, "0"),
            spanId: "0123456789abcdef",
            flow: DIAGNOSTIC_FLOW[flow],
            step,
            outcome: "ok",
          });
        return passing(script, dir, flow);
      });
      expect(result.failedFlows).toEqual([...REQUIRED_QA_FLOWS]);
      store.close();
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
