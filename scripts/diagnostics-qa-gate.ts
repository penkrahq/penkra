import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { openDiagnosticsReader, readLossLedger } from "@penkra/shared/diagnostics/store";

export const REQUIRED_QA_FLOWS = [
  "send",
  "stop",
  "play",
  "queue",
  "archive",
  "multi-window",
  "thread-create",
  "reconnect",
  "provider-switch",
] as const;
export type QaFlow = (typeof REQUIRED_QA_FLOWS)[number];

/** Assertions each Playwright flow must report after checking the live app. */
export const REQUIRED_QA_CHECKS: Record<QaFlow, readonly string[]> = {
  send: ["send.dispatched", "send.accepted"],
  stop: ["stop.requested", "turn.terminal"],
  play: ["play.requested", "turn.started"],
  queue: ["queue.enqueued", "queue.started"],
  archive: ["archive.requested", "thread.archived"],
  "multi-window": ["window.opened", "window.synced"],
  "thread-create": ["thread.create_requested", "thread.created"],
  reconnect: ["socket.disconnected", "socket.reconnected"],
  "provider-switch": ["provider.switch_requested", "provider.switched"],
};

export const DIAGNOSTIC_FLOW: Record<QaFlow, string> = {
  send: "send",
  stop: "stop",
  play: "play",
  queue: "queue",
  archive: "archive",
  "multi-window": "window",
  "thread-create": "thread_create",
  reconnect: "socket_connect",
  "provider-switch": "app",
};

export interface QaFlowResult {
  readonly flow: QaFlow;
  readonly passed: boolean;
  readonly checks: readonly string[];
}

export function evaluateDiagnosticsQaGate(
  beforeIds: ReadonlySet<string>,
  afterIds: ReadonlySet<string>,
  results: ReadonlyArray<QaFlowResult>,
  pending: { expectations: number; spools: number } = { expectations: 0, spools: 0 },
  integrity: {
    storeReset: boolean;
    newLosses: number;
    possiblyLost?: number;
    lostCountUnknown?: number;
    exactOverflow?: number;
  } = { storeReset: false, newLosses: 0 },
): {
  passed: boolean;
  failedFlows: QaFlow[];
  newIncidentIds: string[];
  pendingExpectations: number;
  pendingSpools: number;
  storeReset: boolean;
  newLosses: number;
  possiblyLost: number;
  lostCountUnknown: number;
  exactOverflow: number;
} {
  const failedFlows = REQUIRED_QA_FLOWS.filter(
    (flow) =>
      results.filter((result) => result.flow === flow).length !== 1 ||
      !results.find((result) => result.flow === flow)?.passed ||
      !REQUIRED_QA_CHECKS[flow].every((check) =>
        results.find((result) => result.flow === flow)?.checks.includes(check),
      ),
  );
  const newIncidentIds = [...afterIds].filter((id) => !beforeIds.has(id)).toSorted();
  return {
    passed:
      failedFlows.length === 0 &&
      newIncidentIds.length === 0 &&
      pending.expectations === 0 &&
      pending.spools === 0 &&
      !integrity.storeReset &&
      integrity.newLosses === 0 &&
      (integrity.possiblyLost ?? 0) === 0 &&
      (integrity.lostCountUnknown ?? 0) === 0 &&
      (integrity.exactOverflow ?? 0) === 0,
    failedFlows,
    newIncidentIds,
    pendingExpectations: pending.expectations,
    pendingSpools: pending.spools,
    storeReset: integrity.storeReset,
    newLosses: integrity.newLosses,
    possiblyLost: integrity.possiblyLost ?? 0,
    lostCountUnknown: integrity.lostCountUnknown ?? 0,
    exactOverflow: integrity.exactOverflow ?? 0,
  };
}

function lossCounts(dir: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const name of fs.readdirSync(dir)) {
    if (!/^loss-[a-f0-9]{32}\.bin$/u.test(name)) continue;
    const row = readLossLedger(path.join(dir, name));
    if (!row) throw new Error(`Invalid diagnostics loss ledger: ${name}`);
    counts.set(name, row.count);
  }
  return counts;
}

function countGrowth(
  afterCounts: ReadonlyMap<string, number>,
  beforeCounts: ReadonlyMap<string, number>,
): number {
  return [...afterCounts].reduce(
    (sum, [name, count]) => sum + Math.max(0, count - (beforeCounts.get(name) ?? 0)),
    0,
  );
}

function diagnosticsState(stateDir: string): {
  ids: Set<string>;
  expectations: number;
  spools: number;
  identity: string;
  resetAt: string;
  resetId: string;
  losses: Map<string, number>;
  spoolAnomalies: Map<string, number>;
} {
  const db = openDiagnosticsReader(stateDir);
  if (!db) throw new Error("Diagnostics store must exist before the clean QA gate starts");
  try {
    const rows = db.prepare("SELECT id FROM incident_occurrences").all() as Array<{ id: string }>;
    const reset = db.prepare("SELECT value FROM meta WHERE key = 'reset_at'").get() as
      | { value: string }
      | undefined;
    if (!reset || Number.isNaN(Date.parse(reset.value)))
      throw new Error("Diagnostics store reset timestamp is unavailable");
    const resetId = db.prepare("SELECT value FROM meta WHERE key = 'reset_id'").get() as
      | { value: string }
      | undefined;
    if (!resetId || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(resetId.value))
      throw new Error("Diagnostics store generation is unavailable");
    const expectations = (
      db.prepare("SELECT COUNT(*) AS count FROM expectations").get() as { count: number }
    ).count;
    const anomalyRows = db
      .prepare(
        "SELECT key, value FROM meta WHERE key LIKE 'spool-invalid:%' OR key LIKE 'sequence-gap:%' OR key = 'incident_evictions' OR key LIKE 'possibly-lost:%' OR key LIKE 'lost-count-unknown:%' OR key LIKE 'worker-overflow:%'",
      )
      .all() as Array<{ key: string; value: string }>;
    const spoolAnomalies = new Map<string, number>();
    for (const row of anomalyRows) {
      const count = Number(row.value);
      if (!Number.isSafeInteger(count) || count < 0)
        throw new Error(`Invalid diagnostics spool anomaly count: ${row.key}`);
      spoolAnomalies.set(row.key, count);
    }
    const dir = path.join(stateDir, "diagnostics");
    const spools = fs
      .readdirSync(dir)
      .filter(
        (name) =>
          /^spool-[a-f0-9]{32}\.jsonl$/u.test(name) && fs.statSync(path.join(dir, name)).size > 0,
      ).length;
    return {
      ids: new Set(rows.map((row) => row.id)),
      expectations,
      spools,
      identity: fs.readFileSync(path.join(dir, "identity"), "utf8"),
      resetAt: reset.value,
      resetId: resetId.value,
      losses: lossCounts(dir),
      spoolAnomalies,
    };
  } finally {
    db.close();
  }
}

function observedQaChecks(stateDir: string, flow: QaFlow, afterId: number): readonly string[] {
  const db = openDiagnosticsReader(stateDir);
  if (!db) return [];
  try {
    const rows = db
      .prepare(
        "SELECT trace_id, step, payload_json FROM detail WHERE id > ? AND flow = ? ORDER BY id",
      )
      .all(afterId, DIAGNOSTIC_FLOW[flow]) as Array<{
      trace_id: string;
      step: string;
      payload_json: string;
    }>;
    const byTrace = new Map<string, Set<string>>();
    for (const row of rows) {
      const payload = JSON.parse(row.payload_json) as { outcome?: unknown };
      if (payload.outcome !== "ok") continue;
      const checks = byTrace.get(row.trace_id) ?? new Set<string>();
      checks.add(row.step);
      byTrace.set(row.trace_id, checks);
    }
    return [...byTrace.values()].find((checks) =>
      REQUIRED_QA_CHECKS[flow].every((step) => checks.has(step)),
    )
      ? REQUIRED_QA_CHECKS[flow]
      : [];
  } finally {
    db.close();
  }
}

function lastDetailId(stateDir: string): number {
  const db = openDiagnosticsReader(stateDir);
  if (!db) throw new Error("Diagnostics store is unavailable during clean QA");
  try {
    return (db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM detail").get() as { id: number }).id;
  } finally {
    db.close();
  }
}

function prefixedGrowth(
  after: ReadonlyMap<string, number>,
  before: ReadonlyMap<string, number>,
  prefix: string,
): number {
  return countGrowth(
    new Map([...after].filter(([key]) => key.startsWith(prefix))),
    new Map([...before].filter(([key]) => key.startsWith(prefix))),
  );
}

export function runDiagnosticsQaGate(
  stateDir: string,
  scripts: ReadonlyMap<QaFlow, string>,
  runner: (script: string, stateDir: string, flow: QaFlow) => QaFlowResult = (
    script,
    dir,
    flow,
  ) => {
    const reportPath = path.join(dir, `.diagnostics-qa-${randomUUID()}.json`);
    try {
      const result = spawnSync(process.execPath, [script], {
        stdio: "inherit",
        timeout: 120_000,
        env: {
          ...process.env,
          PENKRA_DIAGNOSTICS_QA_STATE_DIR: dir,
          PENKRA_DIAGNOSTICS_QA_FLOW: flow,
          PENKRA_DIAGNOSTICS_QA_REPORT_PATH: reportPath,
        },
      });
      if (result.status !== 0 || result.error || !fs.existsSync(reportPath))
        return { flow, passed: false, checks: [] };
      const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as QaFlowResult;
      if (
        !report ||
        !REQUIRED_QA_FLOWS.includes(report.flow) ||
        typeof report.passed !== "boolean" ||
        !Array.isArray(report.checks) ||
        !report.checks.every((check) => typeof check === "string")
      )
        return { flow, passed: false, checks: [] };
      return report;
    } catch {
      return { flow, passed: false, checks: [] };
    } finally {
      fs.rmSync(reportPath, { force: true });
    }
  },
): ReturnType<typeof evaluateDiagnosticsQaGate> {
  if (
    scripts.size !== REQUIRED_QA_FLOWS.length ||
    REQUIRED_QA_FLOWS.some((flow) => !scripts.has(flow)) ||
    new Set(scripts.values()).size !== REQUIRED_QA_FLOWS.length
  )
    throw new Error("Clean QA requires one distinct script for every required flow");
  for (const script of scripts.values()) {
    if (!fs.statSync(script).isFile()) throw new Error(`QA script is not a file: ${script}`);
  }
  const before = diagnosticsState(stateDir);
  const results = REQUIRED_QA_FLOWS.map((flow) => {
    const beforeDetailId = lastDetailId(stateDir);
    const report = runner(scripts.get(flow)!, stateDir, flow);
    return {
      flow: report.flow,
      passed: report.passed,
      checks: observedQaChecks(stateDir, flow, beforeDetailId),
    };
  });
  const after = diagnosticsState(stateDir);
  const newLosses =
    countGrowth(after.losses, before.losses) +
    countGrowth(
      new Map(
        [...after.spoolAnomalies].filter(
          ([key]) =>
            !["possibly-lost:", "lost-count-unknown:", "worker-overflow:"].some((prefix) =>
              key.startsWith(prefix),
            ),
        ),
      ),
      before.spoolAnomalies,
    );
  return evaluateDiagnosticsQaGate(before.ids, after.ids, results, after, {
    storeReset:
      before.identity !== after.identity ||
      before.resetAt !== after.resetAt ||
      before.resetId !== after.resetId ||
      [...before.ids].some((id) => !after.ids.has(id)),
    newLosses,
    possiblyLost: prefixedGrowth(after.spoolAnomalies, before.spoolAnomalies, "possibly-lost:"),
    lostCountUnknown: prefixedGrowth(
      after.spoolAnomalies,
      before.spoolAnomalies,
      "lost-count-unknown:",
    ),
    exactOverflow: prefixedGrowth(after.spoolAnomalies, before.spoolAnomalies, "worker-overflow:"),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const args = process.argv.slice(2);
  const stateIndex = args.indexOf("--state-dir");
  if (stateIndex < 0 || !args[stateIndex + 1]) throw new Error("Missing --state-dir");
  const scripts = new Map<QaFlow, string>();
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--script") continue;
    const raw = args[++i];
    const equal = raw?.indexOf("=") ?? -1;
    const flow = raw?.slice(0, equal) as QaFlow;
    if (equal < 1 || !REQUIRED_QA_FLOWS.includes(flow) || scripts.has(flow))
      throw new Error("Invalid or duplicate --script flow=path");
    scripts.set(flow, path.resolve(raw!.slice(equal + 1)));
  }
  const result = runDiagnosticsQaGate(path.resolve(args[stateIndex + 1]!), scripts);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.passed) process.exitCode = 1;
}
