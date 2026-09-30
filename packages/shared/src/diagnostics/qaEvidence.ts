import { createHmac, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const QA_ACTIONS = {
  send: "turn_admitted",
  stop: "turn_terminal",
  play: "turn_started",
  queue: "queue_promoted",
  archive: "thread_archived",
  "multi-window": "window_synced",
  "thread-create": "thread_created",
  reconnect: "socket_reconnected",
  "provider-switch": "provider_switched",
} as const;
export type QaActionFlow = keyof typeof QA_ACTIONS;

export interface QaActionEvidence {
  readonly version: 1;
  readonly runId: string;
  readonly flow: QaActionFlow;
  readonly action: (typeof QA_ACTIONS)[QaActionFlow];
  readonly traceId: string;
  readonly challenge: string;
  readonly at: string;
  readonly signature: string;
}

export interface QaEvidenceConfig {
  readonly dir: string;
  readonly runId: string;
  readonly secret: string;
}

const ID = /^[a-f0-9]{32}$/u;
const CHALLENGE = /^[a-f0-9]{64}$/u;
const RUN_ID = /^[a-f0-9-]{36}$/u;

export function qaEvidenceConfigFromEnv(env = process.env): QaEvidenceConfig | null {
  const dir = env.PENKRA_DIAGNOSTICS_QA_PROOF_DIR;
  const runId = env.PENKRA_DIAGNOSTICS_QA_RUN_ID;
  const secret = env.PENKRA_DIAGNOSTICS_QA_SECRET;
  if (!dir || !runId || !secret) return null;
  if (!RUN_ID.test(runId) || !/^[a-f0-9]{64}$/u.test(secret))
    throw new TypeError("Invalid diagnostics QA proof configuration");
  return { dir, runId, secret };
}

export function qaEvidencePath(config: QaEvidenceConfig): string {
  return path.join(config.dir, `qa-actions-${config.runId}.jsonl`);
}

export function qaChallengePath(config: QaEvidenceConfig, flow: QaActionFlow): string {
  return path.join(config.dir, `qa-challenge-${config.runId}-${flow}`);
}

export function writeQaChallenge(
  config: QaEvidenceConfig,
  flow: QaActionFlow,
  challenge: string,
): void {
  if (!CHALLENGE.test(challenge)) throw new TypeError("Invalid diagnostics QA challenge");
  fs.mkdirSync(config.dir, { recursive: true, mode: 0o700 });
  const target = qaChallengePath(config, flow);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, challenge, { mode: 0o600 });
  fs.renameSync(temporary, target);
}

function unsigned(evidence: Omit<QaActionEvidence, "signature">): string {
  return JSON.stringify([
    evidence.version,
    evidence.runId,
    evidence.flow,
    evidence.action,
    evidence.traceId,
    evidence.challenge,
    evidence.at,
  ]);
}

export function signQaAction(
  config: QaEvidenceConfig,
  flow: QaActionFlow,
  traceId: string,
  challenge: string,
  at = new Date().toISOString(),
): QaActionEvidence {
  if (
    !ID.test(traceId) ||
    !CHALLENGE.test(challenge) ||
    !RUN_ID.test(config.runId) ||
    !CHALLENGE.test(config.secret)
  )
    throw new TypeError("Invalid diagnostics QA action identity");
  const data = {
    version: 1,
    runId: config.runId,
    flow,
    action: QA_ACTIONS[flow],
    traceId,
    challenge,
    at,
  } as const;
  return {
    ...data,
    signature: createHmac("sha256", Buffer.from(config.secret, "hex"))
      .update(unsigned(data))
      .digest("hex"),
  };
}

export function verifyQaAction(
  config: QaEvidenceConfig,
  value: unknown,
  expectedChallenge?: string,
): value is QaActionEvidence {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  if (
    row.version !== 1 ||
    row.runId !== config.runId ||
    typeof row.flow !== "string" ||
    !(row.flow in QA_ACTIONS) ||
    row.action !== QA_ACTIONS[row.flow as QaActionFlow] ||
    typeof row.traceId !== "string" ||
    !ID.test(row.traceId) ||
    typeof row.challenge !== "string" ||
    !CHALLENGE.test(row.challenge) ||
    (expectedChallenge !== undefined && row.challenge !== expectedChallenge) ||
    typeof row.at !== "string" ||
    Number.isNaN(Date.parse(row.at)) ||
    typeof row.signature !== "string" ||
    !/^[a-f0-9]{64}$/u.test(row.signature)
  )
    return false;
  const expected = signQaAction(
    config,
    row.flow as QaActionFlow,
    row.traceId,
    row.challenge,
    row.at,
  ).signature;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(row.signature, "hex"));
}

/** Only app processes receive the secret; QA child scripts do not. */
export function recordQaAction(flow: QaActionFlow, traceId: string): void {
  const config = qaEvidenceConfigFromEnv();
  if (!config) return;
  const challenge = fs.readFileSync(qaChallengePath(config, flow), "utf8").trim();
  const evidence = signQaAction(config, flow, traceId, challenge);
  fs.mkdirSync(config.dir, { recursive: true, mode: 0o700 });
  const handle = fs.openSync(qaEvidencePath(config), "a", 0o600);
  try {
    fs.writeSync(handle, `${JSON.stringify(evidence)}\n`);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

/** Electron main uses the thread pool for the proof fsync. */
export async function recordQaActionAsync(flow: QaActionFlow, traceId: string): Promise<void> {
  const config = qaEvidenceConfigFromEnv();
  if (!config) return;
  const challenge = (await fs.promises.readFile(qaChallengePath(config, flow), "utf8")).trim();
  const evidence = signQaAction(config, flow, traceId, challenge);
  await fs.promises.mkdir(config.dir, { recursive: true, mode: 0o700 });
  const handle = await fs.promises.open(qaEvidencePath(config), "a", 0o600);
  try {
    await handle.write(`${JSON.stringify(evidence)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
