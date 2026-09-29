#!/usr/bin/env node
// Test-only Codex app-server protocol fixture. Never import this from app code.
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

export const FIXTURE_MARKER = "PENKRA_QA_SCRIPTED_PROVIDER_FIXTURE_V1";
const threads = new Map();
const turns = new Map();
const emit = (row) => process.stdout.write(`${JSON.stringify(row)}\n`);
const respond = (id, result) => emit({ id, result });
const notify = (method, params) => emit({ method, params });

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

function handle(message) {
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
      respond(id, { data: [] });
      return;
    case "account/read":
      respond(id, { account: { type: "chatgpt" } });
      return;
    case "thread/start": {
      const threadId = randomUUID();
      threads.set(threadId, { id: threadId });
      respond(id, { thread: { id: threadId, turns: [] } });
      notify("thread/started", { thread: { id: threadId } });
      return;
    }
    case "thread/resume":
    case "thread/read": {
      const threadId = params.threadId;
      if (typeof threadId !== "string" || !threads.has(threadId)) {
        emit({ id, error: { code: -32001, message: "Unknown QA fixture thread" } });
        return;
      }
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
      const turn = { id: turnId, threadId, status: "inProgress", timer: null };
      turns.set(turnId, turn);
      respond(id, { turn: { id: turnId, status: "inProgress", items: [] } });
      notify("turn/started", { threadId, turn: { id: turnId, status: "inProgress" } });
      if (!hold) turn.timer = setTimeout(() => finish(turnId), 300);
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
}
