import assert from "node:assert/strict";
import { mkdir, stat } from "node:fs/promises";
import http, { type ServerResponse } from "node:http";
import path from "node:path";
import { it } from "vitest";
import { contractFixture, listen } from "./support.ts";
import { jsonRpcJournal, NativeRpcError } from "./jsonRpcJournal.ts";
import { requiredCodexMethods } from "./codexRequestCoverage.ts";
import { parseAuthStatusFromOutput } from "../../src/provider/Layers/ProviderHealth.ts";

it("classifies the pinned CLI's exact signed-out login status", async () => {
  const fixture = await contractFixture("codex");
  try {
    let failure: unknown;
    try {
      await fixture.command(["login", "status"]);
    } catch (error) {
      failure = error;
    }
    assert(
      failure instanceof Error && "code" in failure && "stdout" in failure && "stderr" in failure,
    );
    assert.equal(failure.code, 1);
    assert.equal(failure.stdout, "");
    assert.equal(failure.stderr, "Not logged in\n");
    assert.equal(
      parseAuthStatusFromOutput({ code: 1, stdout: "", stderr: failure.stderr as string })
        .authStatus,
      "unauthenticated",
    );
  } finally {
    await fixture.close();
  }
});

interface NativeThread {
  id: string;
  path: string | null;
}
interface NativeTurn {
  id: string;
  status: string;
  error?: unknown;
}

it("reports native completion, rollout path, steer, questions, interrupt and local request failure", async () => {
  const fixture = await contractFixture("codex");
  let rpc: ReturnType<typeof jsonRpcJournal> | undefined;
  let responseId = 0;
  let blockSeen!: () => void;
  let releaseBlock!: () => void;
  let held: ServerResponse | undefined;
  let blocked = new Promise<void>((resolve) => {
    blockSeen = resolve;
  });
  let release = new Promise<void>((resolve) => {
    releaseBlock = resolve;
  });
  const requests: string[] = [];
  const model = http.createServer(async (req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/api/codex/profiles/me") {
        res.end(JSON.stringify({ stats: {} }));
        return;
      }
      res.end(
        JSON.stringify({
          plan_type: "plus",
          rate_limit: {
            allowed: true,
            limit_reached: false,
            primary_window: {
              used_percent: 0,
              limit_window_seconds: 18000,
              reset_after_seconds: 18000,
              reset_at: 2000000000,
            },
          },
          additional_rate_limits: [],
          credits: { has_credits: true, unlimited: false, balance: "10" },
        }),
      );
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push(raw);
    if (raw.includes("FAIL_CONTRACT")) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: "Contract request rejected",
            type: "invalid_request_error",
            code: "contract_invalid",
          },
        }),
      );
      return;
    }
    if (raw.includes("BLOCK_CONTRACT") && !raw.includes("STEER_CONTRACT")) {
      held = res;
      blockSeen();
      await release;
      if (res.destroyed) return;
    }
    const n = ++responseId;
    const isQuestion = raw.includes("QUESTION_CONTRACT") && !raw.includes("function_call_output");
    const item = isQuestion
      ? {
          id: `fc_${n}`,
          type: "function_call",
          call_id: `call_${n}`,
          name: "request_user_input",
          arguments: JSON.stringify({
            questions: [
              {
                id: "color",
                header: "Color",
                question: "Pick a color",
                options: [
                  { label: "Blue", description: "Use blue" },
                  { label: "Red", description: "Use red" },
                ],
              },
            ],
          }),
          status: "completed",
        }
      : {
          id: `msg_${n}`,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "CONTRACT_DONE", annotations: [] }],
          phase: "final_answer",
        };
    const response = {
      id: `resp_${n}`,
      object: "response",
      created_at: 1,
      status: "completed",
      output: [item],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const event of [
      { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response },
    ])
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  try {
    const upstream = await listen(model);
    const home = path.join(fixture.root, "codex-home");
    await mkdir(home);
    const child = fixture.startProcess(
      [
        "app-server",
        "-c",
        'model_provider="contract"',
        "-c",
        'model="contract"',
        "-c",
        'cli_auth_credentials_store="ephemeral"',
        "-c",
        `chatgpt_base_url="${upstream}"`,
        "-c",
        "features.default_mode_request_user_input=true",
        "-c",
        `model_providers.contract={name="Contract",base_url="${upstream}/v1",wire_api="responses",requires_openai_auth=false}`,
      ],
      fixture.root,
      fixture.environment("source", { CODEX_HOME: home }),
    );
    rpc = jsonRpcJournal(child, fixture.signal);
    await rpc.request("initialize", {
      clientInfo: { name: "penkra_contract", version: "1" },
      capabilities: { experimentalApi: true },
    });
    rpc.notify("initialized");
    await rpc.request("account/read", { refreshToken: false });
    await rpc.request("getAuthStatus", { includeToken: true, refreshToken: false });
    const browserLogin = await rpc.request<{ loginId: string }>("account/login/start", {
      type: "chatgpt",
    });
    assert.equal(typeof browserLogin.loginId, "string");
    await rpc.request("account/login/cancel", { loginId: browserLogin.loginId });
    const claims = {
      email: "contract@example.invalid",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "contract-account",
        chatgpt_plan_type: "plus",
        user_id: "contract-user",
      },
    };
    const token = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.contract`;
    await rpc.request("account/login/start", {
      type: "chatgptAuthTokens",
      accessToken: token,
      chatgptAccountId: "contract-account",
      chatgptPlanType: "plus",
    });
    const limits = await rpc.request<{
      rateLimits: { credits: { hasCredits: boolean; balance: string } | null };
    }>("account/rateLimits/read", {});
    assert.equal(limits.rateLimits.credits?.hasCredits, true);
    assert.equal(limits.rateLimits.credits?.balance, "10");
    const usage = await rpc.request<{ summary: Record<string, unknown> }>("account/usage/read", {});
    assert(usage.summary);
    assert("lifetimeTokens" in usage.summary);
    assert.equal("credits" in usage.summary, false);
    await rpc.request("skills/extraRoots/set", { extraRoots: [fixture.root] });
    await rpc.request("plugin/list", { cwds: [fixture.root], marketplaceKinds: ["local"] });
    const models = await rpc.request<{ data: unknown[] }>("model/list", {});
    assert(Array.isArray(models.data));
    assert(
      Array.isArray(
        (
          await rpc.request<{ data: unknown[] }>("skills/list", {
            cwds: [fixture.root],
            forceReload: true,
          })
        ).data,
      ),
    );
    assert.deepEqual(
      (
        await rpc.request<{ marketplaceLoadErrors: unknown[] }>("plugin/installed", {
          cwds: [fixture.root],
        })
      ).marketplaceLoadErrors,
      [],
    );
    await assert.rejects(
      rpc.request("penkra/nonexistentContractMethod", {}),
      (error) => error instanceof NativeRpcError && error.code === -32600,
    );
    await assert.rejects(
      rpc.request("plugin/installed", { cwds: "not-an-array" }),
      (error) => error instanceof NativeRpcError && error.code === -32600,
    );
    const create = async () =>
      (
        await rpc!.request<{ thread: NativeThread }>("thread/start", {
          cwd: fixture.root,
          model: "contract",
          modelProvider: "contract",
          approvalPolicy: "never",
          sandbox: "read-only",
        })
      ).thread;
    const start = async (thread: NativeThread, text: string) =>
      (
        await rpc!.request<{ turn: NativeTurn }>("turn/start", {
          threadId: thread.id,
          input: [{ type: "text", text, text_elements: [] }],
        })
      ).turn;
    const completed = async (thread: NativeThread, turn: NativeTurn) =>
      (
        await rpc!.waitFor(
          (event) =>
            event.method === "turn/completed" &&
            event.params.threadId === thread.id &&
            (event.params.turn as NativeTurn).id === turn.id,
        )
      ).params.turn as NativeTurn;
    const normal = await create();
    assert.equal(typeof normal.path, "string");
    const firstNormalTurn = await start(normal, "Reply hello.");
    assert.equal((await completed(normal, firstNormalTurn)).status, "completed");
    assert(
      (await stat(normal.path!)).isFile(),
      "The native rollout must be usable after the terminal turn event.",
    );
    await rpc.request("mcpServerStatus/list", { threadId: normal.id });
    await rpc.request("thread/read", { threadId: normal.id, includeTurns: true });

    const steering = await create();
    const steeringTurn = await start(steering, "BLOCK_CONTRACT");
    await blocked;
    assert.equal(
      (
        await rpc.request<{ turnId: string }>("turn/steer", {
          threadId: steering.id,
          expectedTurnId: steeringTurn.id,
          input: [{ type: "text", text: "STEER_CONTRACT", text_elements: [] }],
        })
      ).turnId,
      steeringTurn.id,
    );
    releaseBlock();
    assert.equal((await completed(steering, steeringTurn)).status, "completed");
    assert(requests.some((raw) => raw.includes("STEER_CONTRACT")));
    assert.equal(
      rpc.events.filter(
        (event) => event.method === "turn/started" && event.params.threadId === steering.id,
      ).length,
      1,
    );

    const questionThread = await create();
    const questionTurn = await start(questionThread, "QUESTION_CONTRACT");
    const question = await rpc.waitFor(
      (event) =>
        event.method === "item/tool/requestUserInput" &&
        event.params.threadId === questionThread.id,
    );
    assert(question.id !== undefined);
    rpc.reply(question.id, { answers: { color: { answers: ["Blue"] } } });
    assert.equal((await completed(questionThread, questionTurn)).status, "completed");

    blocked = new Promise<void>((resolve) => {
      blockSeen = resolve;
    });
    release = new Promise<void>((resolve) => {
      releaseBlock = resolve;
    });
    const interruptThread = await create();
    const interruptedTurn = await start(interruptThread, "BLOCK_CONTRACT");
    assert(
      (await stat(interruptThread.path!)).isFile(),
      "The reported rollout must exist at first-turn acceptance.",
    );
    await blocked;
    assert(
      (await stat(interruptThread.path!)).isFile(),
      "The reported rollout must exist while the accepted first turn is still blocked upstream.",
    );
    await rpc.request("turn/interrupt", {
      threadId: interruptThread.id,
      turnId: interruptedTurn.id,
    });
    assert.equal((await completed(interruptThread, interruptedTurn)).status, "interrupted");
    assert((await stat(interruptThread.path!)).isFile());
    releaseBlock();

    const failedThread = await create();
    const beforeFailure = requests.length;
    const failed = await completed(failedThread, await start(failedThread, "FAIL_CONTRACT"));
    assert.equal(failed.status, "failed");
    assert((await stat(failedThread.path!)).isFile());
    assert.notEqual(failed.error, null);
    assert.equal(
      requests.slice(beforeFailure).filter((raw) => raw.includes("FAIL_CONTRACT")).length,
      1,
    );
    assert.equal(child.exitCode, null);
    const lastNormalTurn = await start(normal, "Reply again.");
    assert.equal((await completed(normal, lastNormalTurn)).status, "completed");
    await rpc.request("thread/revert", { threadId: normal.id, beforeTurnId: lastNormalTurn.id });
    await rpc.request("thread/unsubscribe", { threadId: normal.id });
    const resumed = await rpc.request<{ thread: NativeThread & { turns: NativeTurn[] } }>(
      "thread/resume",
      {
        threadId: normal.id,
        cwd: fixture.root,
        model: "contract",
        modelProvider: "contract",
        approvalPolicy: "never",
        sandbox: "workspace-write",
        excludeTurns: false,
      },
    );
    assert(
      resumed.thread.turns.some((turn) => turn.id === firstNormalTurn.id),
      "Changing runtime mode on resume must preserve prior turns.",
    );
    const review = await rpc.request<{ turn: NativeTurn }>("review/start", {
      threadId: normal.id,
      delivery: "inline",
      target: { type: "custom", instructions: "Review this fixture." },
    });
    assert.equal((await completed(normal, review.turn)).status, "completed");
    const beforeCompaction = rpc.events.length;
    await rpc.request("thread/compact/start", { threadId: normal.id });
    const compaction = await rpc.waitFor(
      (event) =>
        event.method === "turn/started" &&
        event.params.threadId === normal.id &&
        rpc!.events.indexOf(event) >= beforeCompaction,
    );
    assert.equal(
      (await completed(normal, compaction.params.turn as NativeTurn)).status,
      "completed",
    );
    const missing = (await requiredCodexMethods()).filter(
      (method) => !rpc!.successfulMethods.has(method),
    );
    assert.deepEqual(
      missing,
      [],
      "Every native request used by Penkra must succeed against the pinned binary.",
    );
    rpc.close();
    rpc = undefined;
    await fixture.stop(child);
  } finally {
    releaseBlock();
    held?.destroy();
    rpc?.close();
    model.closeAllConnections();
    model.close();
    await fixture.close();
  }
});
