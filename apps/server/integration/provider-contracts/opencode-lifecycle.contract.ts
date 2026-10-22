import assert from "node:assert/strict";
import http from "node:http";
import { it } from "vitest";
import { contractFixture, listen, nativeEventJournal, nativeJson } from "./support.ts";

interface NativeReply {
  info: { error?: { name: string; data?: { statusCode?: number } } };
  parts: { type: string; text?: string }[];
}

it("reports real question, interrupt, and request-failure facts without stopping the shared server", async () => {
  const fixture = await contractFixture("opencode");
  let journal: Awaited<ReturnType<typeof nativeEventJournal>> | undefined;
  let blocked!: () => void;
  const blockStarted = new Promise<void>((resolve) => {
    blocked = resolve;
  });
  let requests = 0;
  const model = http.createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text) as { messages: { role: string; content: unknown }[] };
    requests++;
    const user = body.messages.findLast((message) => message.role === "user");
    const command =
      typeof user?.content === "string" ? user.content : JSON.stringify(user?.content);
    if (command?.includes("FAIL_CONTRACT")) {
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
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.flushHeaders();
    if (command?.includes("BLOCK_CONTRACT")) {
      blocked();
      return;
    }
    const question =
      command?.includes("QUESTION_CONTRACT") &&
      !body.messages.some((message) => message.role === "tool");
    const delta = question
      ? {
          tool_calls: [
            {
              index: 0,
              id: "call_question",
              type: "function",
              function: {
                name: "question",
                arguments: JSON.stringify({
                  questions: [
                    {
                      header: "Choice",
                      question: "Choose a color",
                      options: [{ label: "Blue", description: "Use blue" }],
                      multiple: false,
                    },
                  ],
                }),
              },
            },
          ],
        }
      : { content: "CONTRACT_DONE" };
    for (const part of [{ role: "assistant", content: "" }, delta])
      res.write(
        `data: ${JSON.stringify({ id: "contract", object: "chat.completion.chunk", created: 1, model: "contract", choices: [{ index: 0, delta: part, finish_reason: null }] })}\n\n`,
      );
    res.end(
      `data: ${JSON.stringify({ id: "contract", object: "chat.completion.chunk", created: 1, model: "contract", choices: [{ index: 0, delta: {}, finish_reason: question ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`,
    );
  });
  try {
    const upstream = await listen(model);
    const env = fixture.environment("source", {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        model: "contract/contract",
        small_model: "contract/contract",
        provider: {
          contract: {
            npm: "@ai-sdk/openai-compatible",
            name: "Contract",
            options: { baseURL: `${upstream}/v1`, apiKey: "contract-only" },
            models: { contract: { name: "contract", limit: { context: 32000, output: 4096 } } },
          },
        },
        permission: { "*": "allow" },
      }),
    });
    const server = await fixture.startServer(
      ["serve", "--port", "0", "--hostname", "127.0.0.1"],
      fixture.root,
      env,
      /opencode server listening on (http:\/\/[^\s]+)/,
    );
    journal = await nativeEventJournal(server.origin, fixture.signal);
    const api = <T>(route: string, body?: unknown) =>
      nativeJson<T>(server.origin, route, fixture.root, fixture.signal, body);
    const create = () => api<{ id: string }>("/session", { title: "Lifecycle contract" });
    const prompt = (id: string, text: string) =>
      api<NativeReply>(`/session/${id}/message`, {
        model: { providerID: "contract", modelID: "contract" },
        parts: [{ type: "text", text }],
      });

    const questionSession = await create();
    const answering = prompt(questionSession.id, "QUESTION_CONTRACT");
    const asked = await journal.waitFor(
      (event) =>
        event.payload.type === "question.asked" &&
        event.payload.properties.sessionID === questionSession.id,
    );
    const questionId = asked.payload.properties.id;
    assert.equal(typeof questionId, "string");
    assert.equal(await api(`/question/${questionId}/reply`, { answers: [["Blue"]] }), true);
    const answered = await answering;
    assert.equal(answered.info.error, undefined);
    assert(answered.parts.some((part) => part.text === "CONTRACT_DONE"));
    await journal.waitFor(
      (event) =>
        event.payload.type === "session.idle" &&
        event.payload.properties.sessionID === questionSession.id,
    );

    const interruptedSession = await create();
    const interrupting = prompt(interruptedSession.id, "BLOCK_CONTRACT");
    await blockStarted;
    assert.equal(await api(`/session/${interruptedSession.id}/abort`, {}), true);
    const interrupted = await interrupting;
    assert.equal(interrupted.info.error?.name, "MessageAbortedError");
    await journal.waitFor(
      (event) =>
        event.payload.type === "session.idle" &&
        event.payload.properties.sessionID === interruptedSession.id,
    );

    const failedSession = await create();
    const beforeFailure = requests;
    const failed = await prompt(failedSession.id, "FAIL_CONTRACT");
    assert.equal(failed.info.error?.name, "APIError");
    assert.equal(failed.info.error?.data?.statusCode, 400);
    assert.equal(requests - beforeFailure, 1, "A rejected model request must not be replayed.");
    await journal.waitFor(
      (event) =>
        event.payload.type === "session.error" &&
        event.payload.properties.sessionID === failedSession.id,
    );
    await journal.waitFor(
      (event) =>
        event.payload.type === "session.idle" &&
        event.payload.properties.sessionID === failedSession.id,
    );
    const healthySession = await create();
    assert(
      (await prompt(healthySession.id, "Reply normally.")).parts.some(
        (part) => part.text === "CONTRACT_DONE",
      ),
    );
    assert.equal(server.child.exitCode, null);
    await journal.close();
    journal = undefined;
    await fixture.stop(server.child);
  } finally {
    model.closeAllConnections();
    model.close();
    try {
      await journal?.close();
    } finally {
      await fixture.close();
    }
  }
});
