#!/usr/bin/env bun
// Local-model eval harness. Runs a fixed Penkra-style task suite against any
// OpenAI-compatible chat endpoint (mlx_lm.server, llama-server, ...).
//
//   bun benchmarks/local-models/run.ts --base http://127.0.0.1:8080/v1 --model <id> \
//     [--label mlx-qwen] [--pid <server pid>] [--only basic] [--out results/x.json]
//
// Each task gets a scratch copy of its fixture, a small tool set, and a turn
// budget. A checker decides pass/fail from the final workspace and answer.

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RepetitionGuard } from "../../apps/server/src/provider/localModels/repetitionGuard.ts";
import { TASKS, type Task } from "./tasks.ts";

type Msg = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1] ?? "");
const BASE = args.get("base") ?? "http://127.0.0.1:8080/v1";
const MODEL = args.get("model") ?? "default";
const LABEL = args.get("label") ?? MODEL;
const PID = args.get("pid");
const ONLY = args.get("only");
const MAX_TURNS = Number(args.get("turns") ?? 12);

const SYSTEM = `You are a coding agent working in a project directory. Use the tools to inspect and change files and to run commands. Paths are relative to the project root. When the task is done, reply with a short final answer and no tool calls.`;

const TOOLS = [
  fn("list_dir", "List files in a directory.", { path: { type: "string" } }, ["path"]),
  fn("read_file", "Read a text file.", { path: { type: "string" } }, ["path"]),
  fn("write_file", "Create or overwrite a text file with the full new content.", { path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
  fn("edit_file", "Replace one exact occurrence of old_text with new_text in a file.", { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, ["path", "old_text", "new_text"]),
  fn("run_command", "Run a shell command in the project root and return its output. Allowed: bun, node, ls, cat, grep.", { command: { type: "string" } }, ["command"]),
];

function fn(name: string, description: string, properties: object, required: string[]) {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}

function inside(root: string, p: string): string {
  const full = path.resolve(root, p);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error("path escapes project root");
  return full;
}

function runTool(root: string, call: ToolCall): { output: string; valid: boolean } {
  let a: Record<string, string>;
  try {
    a = JSON.parse(call.function.arguments || "{}");
  } catch {
    return { output: "error: arguments are not valid JSON", valid: false };
  }
  try {
    switch (call.function.name) {
      case "list_dir":
        return { output: fs.readdirSync(inside(root, a.path ?? ".")).join("\n"), valid: true };
      case "read_file":
        return { output: fs.readFileSync(inside(root, a.path!), "utf8"), valid: true };
      case "write_file":
        fs.mkdirSync(path.dirname(inside(root, a.path!)), { recursive: true });
        fs.writeFileSync(inside(root, a.path!), a.content ?? "");
        return { output: "ok", valid: true };
      case "edit_file": {
        const f = inside(root, a.path!);
        const text = fs.readFileSync(f, "utf8");
        const n = text.split(a.old_text!).length - 1;
        if (n !== 1) return { output: `error: old_text found ${n} times`, valid: true };
        fs.writeFileSync(f, text.replace(a.old_text!, a.new_text ?? ""));
        return { output: "ok", valid: true };
      }
      case "run_command": {
        const cmd = (a.command ?? "").trim();
        if (!/^(bun|node|ls|cat|grep)\b/.test(cmd) || /[;&|`$><]/.test(cmd.replace(/^grep .*/, "grep"))) {
          return { output: "error: command not allowed", valid: true };
        }
        const r = spawnSync("/bin/sh", ["-c", cmd], { cwd: root, encoding: "utf8", timeout: 60_000 });
        return { output: `${r.stdout}${r.stderr}`.slice(-6000) + `\n(exit ${r.status})`, valid: true };
      }
      default:
        return { output: `error: unknown tool ${call.function.name}`, valid: false };
    }
  } catch (e) {
    return { output: `error: ${(e as Error).message}`, valid: true };
  }
}

let loopsStopped = 0;

type Turn = { ttftMs: number; decodeTps: number | null; completionTokens: number; promptTokens: number };

async function chat(messages: Msg[]): Promise<{ msg: Msg; turn: Turn }> {
  const started = performance.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, tools: TOOLS, stream: true, temperature: 0.2, max_tokens: 16384, stream_options: { include_usage: true } }),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  let first = 0;
  let content = "";
  const calls: ToolCall[] = [];
  let usage: { prompt_tokens?: number; completion_tokens?: number } = {};
  let buf = "";
  const decoder = new TextDecoder();
  // Same loop guard as the Local proxy: a repeating model ends its turn.
  const guard = new RepetitionGuard();
  let looped = false;
  stream: for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      const j = JSON.parse(data);
      if (j.usage) usage = j.usage;
      const d = j.choices?.[0]?.delta;
      if (!d) continue;
      if (!first && (d.content || d.tool_calls)) first = performance.now();
      if (d.content) content += d.content;
      for (const tc of d.tool_calls ?? []) {
        const at = tc.index ?? calls.length;
        calls[at] ??= { id: tc.id ?? `call_${at}`, type: "function", function: { name: "", arguments: "" } };
        if (tc.id) calls[at]!.id = tc.id;
        if (tc.function?.name) calls[at]!.function.name += tc.function.name;
        if (tc.function?.arguments) calls[at]!.function.arguments += tc.function.arguments;
      }
      const args = (d.tool_calls ?? []).map((c: { function?: { arguments?: string } }) => c.function?.arguments);
      for (const text of [d.reasoning ?? d.reasoning_content, d.content, ...args]) {
        if (typeof text === "string" && guard.push(text)) looped = true;
      }
      if (looped) break stream;
    }
  }
  if (looped) loopsStopped++;
  const end = performance.now();
  const completionTokens = usage.completion_tokens ?? 0;
  const decodeSec = first ? (end - first) / 1000 : 0;
  return {
    msg: { role: "assistant", content: content || null, ...(calls.length ? { tool_calls: calls.filter(Boolean) } : {}) },
    turn: {
      ttftMs: first ? first - started : end - started,
      decodeTps: completionTokens > 1 && decodeSec > 0 ? completionTokens / decodeSec : null,
      completionTokens,
      promptTokens: usage.prompt_tokens ?? 0,
    },
  };
}

// phys_footprint counts unified GPU memory (MLX/Metal); plain RSS does not.
function rssMb(): number | null {
  if (!PID) return null;
  try {
    const out = execFileSync("footprint", [PID], { encoding: "utf8" });
    const m = /phys_footprint:\s*([\d.]+)\s*(KB|MB|GB)/.exec(out);
    if (!m) return null;
    return Math.round(Number(m[1]) * ({ KB: 1 / 1024, MB: 1, GB: 1024 } as const)[m[2] as "KB" | "MB" | "GB"]);
  } catch {
    return null;
  }
}

async function runTask(task: Task) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `lm-${task.id}-`));
  task.setup(root);
  const messages: Msg[] = [{ role: "system", content: SYSTEM }, { role: "user", content: task.prompt }];
  const turns: Turn[] = [];
  let toolCalls = 0;
  let invalidCalls = 0;
  let answer = "";
  let error: string | null = null;
  const started = performance.now();
  try {
    for (let t = 0; t < MAX_TURNS; t++) {
      const { msg, turn } = await chat(messages);
      turns.push(turn);
      messages.push(msg);
      if (!msg.tool_calls?.length) {
        answer = msg.content ?? "";
        break;
      }
      for (const call of msg.tool_calls) {
        toolCalls++;
        const r = runTool(root, call);
        if (!r.valid) invalidCalls++;
        messages.push({ role: "tool", tool_call_id: call.id, content: r.output });
      }
    }
  } catch (e) {
    error = (e as Error).message;
  }
  let pass = false;
  try {
    pass = !error && task.check(root, answer);
  } catch {
    pass = false;
  }
  if (process.env.LM_DUMP) fs.writeFileSync(`${process.env.LM_DUMP}/${LABEL}-${task.id}.json`, JSON.stringify(messages, null, 2));
  fs.rmSync(root, { recursive: true, force: true });
  const tps = turns.map((t) => t.decodeTps).filter((x): x is number => x !== null);
  return {
    id: task.id,
    tier: task.tier,
    pass,
    error,
    turns: turns.length,
    toolCalls,
    invalidCalls,
    seconds: Math.round((performance.now() - started) / 100) / 10,
    firstTtftMs: Math.round(turns[0]?.ttftMs ?? 0),
    maxPromptTokens: Math.max(0, ...turns.map((t) => t.promptTokens)),
    medianDecodeTps: tps.length ? Math.round(tps.sort((a, b) => a - b)[Math.floor(tps.length / 2)]! * 10) / 10 : null,
    rssMb: rssMb(),
  };
}

const TASK = args.get("task");
const tasks = TASKS.filter((t) => (!ONLY || t.tier === ONLY) && (!TASK || t.id === TASK));
const results = [];
for (const task of tasks) {
  process.stdout.write(`${task.id.padEnd(28)} `);
  const r = await runTask(task);
  results.push(r);
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.seconds}s  turns=${r.turns} tools=${r.toolCalls} invalid=${r.invalidCalls} ttft=${r.firstTtftMs}ms tps=${r.medianDecodeTps ?? "-"}${r.error ? `  ${r.error.slice(0, 120)}` : ""}`);
}
const summary = {
  label: LABEL,
  model: MODEL,
  base: BASE,
  at: new Date().toISOString(),
  basicPassed: results.filter((r) => r.tier === "basic" && r.pass).length,
  basicTotal: results.filter((r) => r.tier === "basic").length,
  fullPassed: results.filter((r) => r.tier === "full" && r.pass).length,
  fullTotal: results.filter((r) => r.tier === "full").length,
  peakRssMb: Math.max(0, ...results.map((r) => r.rssMb ?? 0)) || null,
  results,
};
console.log(`\n${LABEL}: basic ${summary.basicPassed}/${summary.basicTotal}, full ${summary.fullPassed}/${summary.fullTotal}, loops stopped ${loopsStopped}`);
const out = args.get("out") ?? path.join(import.meta.dir, "results", `${LABEL.replace(/[^\w.-]+/g, "_")}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(summary, null, 2));
console.log(`wrote ${out}`);
