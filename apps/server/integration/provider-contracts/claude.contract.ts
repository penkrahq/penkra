import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter, on } from "node:events";
import http from "node:http";
import path from "node:path";
import { PassThrough } from "node:stream";
import { query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { it } from "vitest";
import { contractFixture, listen } from "./support.ts";

it("uses the pinned SDK/CLI for catalogs, turns, questions, interruption and a later turn", async () => {
  const fixture = await contractFixture("claudeAgent");
  const changes = new EventEmitter();
  const messages: SDKMessage[] = [];
  const requests: string[] = [];
  let failure: unknown;
  let closing = false;
  let ended = false;
  let counter = 0;
  let phase = "startup";
  let diagnostics = "";
  let rejectedRequests = 0;
  const nativeChildren: ChildProcessWithoutNullStreams[] = [];
  let blockSeen!: () => void;
  const blocked = new Promise<void>((resolve) => {
    blockSeen = resolve;
  });
  let questionSeen!: () => void;
  const questionAsked = new Promise<void>((resolve) => {
    questionSeen = resolve;
  });
  let answer!: () => void;
  const questionAnswer = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const model = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (req.url?.includes("count_tokens")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ input_tokens: 10 }));
      return;
    }
    const body = JSON.parse(raw) as {
      model: string;
      messages: { role: string; content: unknown }[];
    };
    requests.push(raw);
    const content = body.messages.findLast((message) => message.role === "user")?.content;
    const command =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? (content as { type: string; text?: string }[]).findLast((part) => part.type === "text")
              ?.text
          : undefined;
    if (command?.trim() === "FAIL_CONTRACT") {
      rejectedRequests++;
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: "Contract request rejected" },
          request_id: "contract-request",
        }),
      );
      return;
    }
    if (command?.trim() === "BLOCK_CONTRACT") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.flushHeaders();
      blockSeen();
      return;
    }
    const n = ++counter;
    const hasToolResult = raw.includes('"tool_result"');
    const question = command?.includes("QUESTION_CONTRACT") && !hasToolResult;
    const event = (type: string, data: unknown) =>
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    event("message_start", {
      type: "message_start",
      message: {
        id: `msg_contract_${n}`,
        type: "message",
        role: "assistant",
        content: [],
        model: body.model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    });
    const toolInput = {
      questions: [
        {
          header: "Color",
          question: "Choose a color",
          options: [
            { label: "Blue", description: "Use blue" },
            { label: "Red", description: "Use red" },
          ],
          multiSelect: false,
        },
      ],
    };
    event("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: question
        ? { type: "tool_use", id: `toolu_${n}`, name: "AskUserQuestion", input: {} }
        : { type: "text", text: "" },
    });
    event("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: question
        ? { type: "input_json_delta", partial_json: JSON.stringify(toolInput) }
        : { type: "text_delta", text: "CONTRACT_DONE" },
    });
    event("content_block_stop", { type: "content_block_stop", index: 0 });
    event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: question ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 5 },
    });
    event("message_stop", { type: "message_stop" });
    res.end();
  });
  const input = new PassThrough({ objectMode: true });
  const abortController = new AbortController();
  const abort = () => abortController.abort(fixture.signal.reason);
  fixture.signal.addEventListener("abort", abort, { once: true });
  let runtime: ReturnType<typeof query> | undefined;
  let draining: Promise<void> | undefined;
  const waitFor = async (predicate: (message: SDKMessage) => boolean, after = 0) => {
    const found = messages.slice(after).find(predicate);
    if (found) return found;
    if (failure) throw failure;
    if (ended) throw new Error("Claude SDK stream ended before the expected native event.");
    for await (const _ of on(changes, "change", { signal: fixture.signal })) {
      const value = messages.slice(after).find(predicate);
      if (value) return value;
      if (failure) throw failure;
      if (ended) throw new Error("Claude SDK stream ended before the expected native event.");
    }
    throw new Error("Claude SDK observation ended.");
  };
  const send = (text: string) =>
    input.write({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: "",
      uuid: randomUUID(),
    } satisfies SDKUserMessage);
  try {
    const upstream = await listen(model);
    const env = {
      ...fixture.environment("source", {
        ANTHROPIC_BASE_URL: upstream,
        CLAUDE_CONFIG_DIR: path.join(fixture.root, "claude-config"),
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      }),
      ANTHROPIC_API_KEY: "contract-only",
    };
    runtime = query({
      prompt: input,
      options: {
        cwd: fixture.root,
        pathToClaudeCodeExecutable: fixture.binary,
        env,
        settingSources: [],
        model: "sonnet",
        tools: ["AskUserQuestion"],
        permissionMode: "default",
        persistSession: true,
        includePartialMessages: true,
        stderr: (line) => {
          diagnostics = (diagnostics + line).slice(-4000);
        },
        abortController,
        spawnClaudeCodeProcess: (options) => {
          assert(options.env);
          const child = fixture.startProcess(options.args, fixture.root, options.env);
          nativeChildren.push(child);
          return child;
        },
        canUseTool: async (name, toolInput) => {
          assert.equal(name, "AskUserQuestion");
          questionSeen();
          await questionAnswer;
          return {
            behavior: "allow",
            updatedInput: { ...toolInput, answers: { "Choose a color": "Blue" } },
          };
        },
      },
    });
    draining = (async () => {
      try {
        for await (const message of runtime!) {
          messages.push(message);
          changes.emit("change");
        }
      } catch (error) {
        if (!closing) failure = error;
      } finally {
        ended = true;
        changes.emit("change");
      }
    })();
    phase = "catalog.models";
    assert(Array.isArray(await runtime.supportedModels()));
    phase = "catalog.commands";
    assert(Array.isArray(await runtime.supportedCommands()));
    assert(Array.isArray(await runtime.supportedAgents()));
    phase = "first-turn";
    send("Reply hello.");
    const first = await waitFor((message) => message.type === "result");
    assert.equal(first.type === "result" ? first.is_error : true, false);

    const questionOffset = messages.length;
    phase = "question";
    send("QUESTION_CONTRACT");
    await questionAsked;
    answer();
    const result = await waitFor((message) => message.type === "result", questionOffset);
    assert.equal(result.type === "result" ? result.is_error : true, false);

    const interruptOffset = messages.length;
    phase = "interrupt";
    send("BLOCK_CONTRACT");
    await blocked;
    const receipt = await runtime.interrupt();
    const interrupted = await waitFor((message) => message.type === "result", interruptOffset);
    assert(
      receipt !== undefined,
      "The pinned CLI must acknowledge the interrupt with its typed receipt.",
    );
    assert.equal(interrupted.type, "result");
    const laterOffset = messages.length;
    phase = "later-turn";
    send("Reply normally again.");
    const later = await waitFor((message) => message.type === "result", laterOffset);
    assert.equal(later.type === "result" ? later.is_error : true, false);
    phase = "request-failure";
    const failureOffset = messages.length;
    send("FAIL_CONTRACT");
    const rejected = await waitFor((message) => message.type === "result", failureOffset);
    assert.equal(rejected.type === "result" ? rejected.is_error : false, true);
    assert.equal(rejected.type === "result" ? rejected.subtype : "", "success");
    assert.equal(
      interrupted.type === "result" ? interrupted.subtype : "",
      "error_during_execution",
    );
    assert(rejectedRequests > 0);
    assert.equal(
      rejected.type === "result" && rejected.subtype === "success"
        ? rejected.api_error_status
        : undefined,
      400,
    );
    assert(
      messages
        .slice(failureOffset)
        .some((message) => message.type === "assistant" && message.error === "unknown"),
    );
    assert.equal(
      messages.slice(failureOffset).filter((message) => message.type === "result").length,
      1,
    );
    const recoveryOffset = messages.length;
    phase = "turn-after-failure";
    send("Reply once more.");
    const recovered = await waitFor((message) => message.type === "result", recoveryOffset);
    assert.equal(recovered.type === "result" ? recovered.is_error : true, false);
    assert.equal(nativeChildren.length, 1);
    assert.equal(nativeChildren[0]!.exitCode, null);
    assert(requests.length >= 4);
  } catch (error) {
    throw new Error(
      `Claude native contract failed during ${phase}; events=${messages.map((message) => (message.type === "result" ? `result:${message.subtype}` : message.type)).join(",")}; stderr=${diagnostics}`,
      { cause: error },
    );
  } finally {
    fixture.signal.removeEventListener("abort", abort);
    closing = true;
    answer();
    input.end();
    runtime?.close();
    model.closeAllConnections();
    model.close();
    await draining;
    await fixture.close();
  }
});
