import { spawnSync } from "node:child_process";
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

export interface QaFlowResult {
  readonly flow: QaFlow;
  readonly passed: boolean;
}

export function evaluateDiagnosticsQaGate(
  beforeIds: ReadonlySet<string>,
  afterIds: ReadonlySet<string>,
  results: ReadonlyArray<QaFlowResult>,
  pending: { expectations: number; spools: number } = { expectations: 0, spools: 0 },
  integrity: { storeReset: boolean; newLosses: number } = { storeReset: false, newLosses: 0 },
): {
  passed: boolean;
  failedFlows: QaFlow[];
  newIncidentIds: string[];
  pendingExpectations: number;
  pendingSpools: number;
  storeReset: boolean;
  newLosses: number;
} {
  const failedFlows = REQUIRED_QA_FLOWS.filter(
    (flow) =>
      results.filter((result) => result.flow === flow).length !== 1 ||
      !results.find((result) => result.flow === flow)?.passed,
  );
  const newIncidentIds = [...afterIds].filter((id) => !beforeIds.has(id)).toSorted();
  return {
    passed:
      failedFlows.length === 0 &&
      newIncidentIds.length === 0 &&
      pending.expectations === 0 &&
      pending.spools === 0 &&
      !integrity.storeReset &&
      integrity.newLosses === 0,
    failedFlows,
    newIncidentIds,
    pendingExpectations: pending.expectations,
    pendingSpools: pending.spools,
    storeReset: integrity.storeReset,
    newLosses: integrity.newLosses,
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
  losses: Map<string, number>;
  spoolAnomalies: Map<string, number>;
} {
  const db = openDiagnosticsReader(stateDir);
  if (!db) throw new Error("Diagnostics store must exist before the clean QA gate starts");
  try {
    const rows = db.prepare("SELECT id FROM incident_occurrences").all() as Array<{ id: string }>;
    const expectations = (
      db.prepare("SELECT COUNT(*) AS count FROM expectations").get() as { count: number }
    ).count;
    const anomalyRows = db
      .prepare(
        "SELECT key, value FROM meta WHERE key LIKE 'spool-invalid:%' OR key LIKE 'sequence-gap:%' OR key = 'incident_evictions'",
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
      losses: lossCounts(dir),
      spoolAnomalies,
    };
  } finally {
    db.close();
  }
}

export function runDiagnosticsQaGate(
  stateDir: string,
  scripts: ReadonlyMap<QaFlow, string>,
  runner: (script: string, stateDir: string) => boolean = (script, dir) => {
    const result = spawnSync(process.execPath, [script], {
      stdio: "inherit",
      timeout: 120_000,
      env: { ...process.env, PENKRA_DIAGNOSTICS_QA_STATE_DIR: dir },
    });
    return result.status === 0 && result.error === undefined;
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
  const results = REQUIRED_QA_FLOWS.map((flow) => ({
    flow,
    passed: runner(scripts.get(flow)!, stateDir),
  }));
  const after = diagnosticsState(stateDir);
  const newLosses =
    countGrowth(after.losses, before.losses) +
    countGrowth(after.spoolAnomalies, before.spoolAnomalies);
  return evaluateDiagnosticsQaGate(before.ids, after.ids, results, after, {
    storeReset:
      before.identity !== after.identity || [...before.ids].some((id) => !after.ids.has(id)),
    newLosses,
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
