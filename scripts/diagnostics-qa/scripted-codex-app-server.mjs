#!/usr/bin/env node
// Test-only Codex app-server protocol fixture. Never import this from app code.
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";

export const FIXTURE_MARKER = "PENKRA_QA_SCRIPTED_PROVIDER_FIXTURE_V1";
const threads = new Map();
const turns = new Map();
const pendingWriteCalls = new Map();
let nextWriteCallId = 1_000_000;
const alternateProfileKey = createHash("sha256").update("qa-scripted-alternate").digest("hex");
const fixtureEmail = process.env.CODEX_HOME?.includes(alternateProfileKey)
  ? "qa-fixture-alternate@example.invalid"
  : "qa-fixture@example.invalid";
const emit = (row) => process.stdout.write(`${JSON.stringify(row)}\n`);
const respond = (id, result) => emit({ id, result });
const notify = (method, params) => emit({ method, params });

function writeRollout(threadId) {
  const home = process.env.CODEX_HOME;
  if (!home) throw new Error("QA fixture requires an isolated CODEX_HOME");
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const directory = path.join(home, "sessions", year, month, day);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const timestamp = now.toISOString().replaceAll(":", "-").replaceAll(".", "-");
  fs.writeFileSync(path.join(directory, `rollout-${timestamp}-${threadId}.jsonl`), "{}\n", {
    flag: "wx",
    mode: 0o600,
  });
}

function hasRollout(threadId) {
  if (!/^[0-9a-f-]{36}$/u.test(threadId)) return false;
  const sessions = path.join(process.env.CODEX_HOME ?? "", "sessions");
  if (!process.env.CODEX_HOME || !fs.existsSync(sessions)) return false;
  return fs
    .readdirSync(sessions, { recursive: true })
    .some((entry) => String(entry).endsWith(`-${threadId}.jsonl`));
}

function finish(turnId, status = "completed") {
  const active = turns.get(turnId);
  if (!active || active.status !== "inProgress") return;
  active.status = status;
  if (active.timer) clearTimeout(active.timer);
  notify("turn/completed", {
    threadId: active.threadId,
    turn: { id: turnId, status, items: [] },
  });
}

function requestAgentWrite(turn, targetThreadId, phase) {
  const id = nextWriteCallId++;
  pendingWriteCalls.set(id, { targetThreadId, phase });
  emit({
    jsonrpc: "2.0",
    id,
    method: "item/tool/call",
    params: {
      threadId: turn.threadId,
      turnId: turn.id,
      callId: `qa-agent-write-${phase}-${id}`,
      namespace: null,
      tool: "penkra_exec_command",
      arguments: {
        command: `penkra threads send --thread-id ${targetThreadId} --message 'qa agent write ${phase}'`,
      },
    },
  });
}

function recordAgentWriteResponse(message) {
  const pending = pendingWriteCalls.get(message.id);
  if (!pending) return;
  pendingWriteCalls.delete(message.id);
  const proofDir = process.env.PENKRA_DIAGNOSTICS_QA_PROOF_DIR;
  if (!proofDir) return;
  fs.appendFileSync(
    path.join(proofDir, "agent-write-steer.jsonl"),
    `${JSON.stringify({ ...pending, success: message.result?.success === true })}\n`,
    { mode: 0o600 },
  );
}

function handle(message) {
  if (typeof message?.id === "number" && typeof message.method !== "string") {
    recordAgentWriteResponse(message);
    return;
  }
  if (typeof message?.id !== "number" || typeof message.method !== "string") return;
  const params = message.params ?? {};
  const id = message.id;
  switch (message.method) {
    case "initialize":
      respond(id, { userAgent: "penkra-diagnostics-qa-fixture" });
      return;
    case "skills/list":
      respond(id, { data: [] });
      return;
    case "plugin/list":
      respond(id, { plugins: [] });
      return;
    case "model/list":
      respond(id, {
        data: [
          {
            id: "qa-fixture-model",
            name: "QA Fixture Model",
            isDefault: true,
            supportedReasoningEfforts: ["low", "medium", "high"],
            defaultReasoningEffort: "medium",
          },
        ],
      });
      return;
    case "account/read":
      respond(id, { account: { type: "chatgpt", email: fixtureEmail } });
      return;
    case "thread/start": {
      const threadId = randomUUID();
      writeRollout(threadId);
      threads.set(threadId, { id: threadId });
      respond(id, { thread: { id: threadId, turns: [] } });
      notify("thread/started", { thread: { id: threadId } });
      return;
    }
    case "thread/resume":
    case "thread/read": {
      const threadId = params.threadId;
      if (typeof threadId !== "string" || (!threads.has(threadId) && !hasRollout(threadId))) {
        emit({ id, error: { code: -32001, message: "Unknown QA fixture thread" } });
        return;
      }
      threads.set(threadId, { id: threadId });
      respond(id, {
        thread: {
          id: threadId,
          turns: [...turns.values()]
            .filter((turn) => turn.threadId === threadId)
            .map((turn) => ({ id: turn.id, status: turn.status, items: [] })),
        },
      });
      return;
    }
    case "turn/start": {
      const threadId = params.threadId;
      if (typeof threadId !== "string" || !threads.has(threadId)) {
        emit({ id, error: { code: -32001, message: "Unknown QA fixture thread" } });
        return;
      }
      const turnId = randomUUID();
      const hold = Array.isArray(params.input)
        ? params.input.some((item) => item?.type === "text" && item.text === "qa:hold")
        : false;
      const queueFirst = Array.isArray(params.input)
        ? params.input.some((item) => item?.type === "text" && item.text === "qa:queue-first")
        : false;
      const writeTarget = Array.isArray(params.input)
        ? params.input
            .find(
              (item) => item?.type === "text" && /^qa:agent-write:[0-9a-f-]{36}$/u.test(item.text),
            )
            ?.text.slice("qa:agent-write:".length)
        : undefined;
      const turn = { id: turnId, threadId, status: "inProgress", timer: null, writeTarget };
      turns.set(turnId, turn);
      respond(id, { turn: { id: turnId, status: "inProgress", items: [] } });
      notify("turn/started", { threadId, turn: { id: turnId, status: "inProgress" } });
      if (writeTarget) setTimeout(() => requestAgentWrite(turn, writeTarget, "before-steer"), 50);
      if (!hold && !writeTarget)
        turn.timer = setTimeout(() => finish(turnId), queueFirst ? 8_000 : 300);
      return;
    }
    case "turn/steer": {
      const turn = turns.get(params.expectedTurnId);
      if (!turn || turn.status !== "inProgress" || turn.threadId !== params.threadId) {
        emit({ id, error: { code: -32001, message: "No active QA fixture turn to steer" } });
        return;
      }
      respond(id, { turnId: turn.id });
      if (turn.writeTarget)
        setTimeout(() => requestAgentWrite(turn, turn.writeTarget, "after-steer"), 50);
      return;
    }
    case "turn/interrupt": {
      const turnId = params.turnId;
      respond(id, {});
      if (typeof turnId === "string") finish(turnId, "interrupted");
      return;
    }
    default:
      respond(id, {});
  }
}

if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 1.0.0-penkra-qa-fixture\n");
} else if (process.argv.includes("app-server")) {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    try {
      handle(JSON.parse(line));
    } catch {
      // Malformed fixture input must not send a success response.
    }
  });
} else if (process.argv.includes("exec")) {
  const outputIndex = process.argv.indexOf("--output-last-message");
  const outputPath = process.argv[outputIndex + 1];
  if (outputIndex < 0 || !outputPath) {
    throw new Error("QA fixture exec requires --output-last-message");
  }
  process.stdin.resume();
  process.stdin.on("end", () => {
    fs.writeFileSync(outputPath, JSON.stringify({ title: "QA Diagnostics Flow" }));
  });
}
