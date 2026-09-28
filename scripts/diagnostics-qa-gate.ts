import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { openDiagnosticsReader } from "@penkra/shared/diagnostics/store";

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
): { passed: boolean; failedFlows: QaFlow[]; newIncidentIds: string[] } {
  const failedFlows = REQUIRED_QA_FLOWS.filter(
    (flow) =>
      results.filter((result) => result.flow === flow).length !== 1 ||
      !results.find((result) => result.flow === flow)?.passed,
  );
  const newIncidentIds = [...afterIds].filter((id) => !beforeIds.has(id)).toSorted();
  return {
    passed: failedFlows.length === 0 && newIncidentIds.length === 0,
    failedFlows,
    newIncidentIds,
  };
}

function occurrenceIds(stateDir: string): Set<string> {
  const db = openDiagnosticsReader(stateDir);
  if (!db) throw new Error("Diagnostics store must exist before the clean QA gate starts");
  try {
    const rows = db.prepare("SELECT id FROM incident_occurrences").all() as Array<{ id: string }>;
    return new Set(rows.map((row) => row.id));
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
  const before = occurrenceIds(stateDir);
  const results = REQUIRED_QA_FLOWS.map((flow) => ({
    flow,
    passed: runner(scripts.get(flow)!, stateDir),
  }));
  return evaluateDiagnosticsQaGate(before, occurrenceIds(stateDir), results);
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
