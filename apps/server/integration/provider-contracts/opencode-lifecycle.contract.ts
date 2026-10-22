import assert from "node:assert/strict";
import { once } from "node:events";
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
  let peerJournal: Awaited<ReturnType<typeof nativeEventJournal>> | undefined;
  let blocked!: () => void;
  const blockStarted = new Promise<void>((resolve) => {
    blocked = resolve;
  });
  let requests = 0;
  const crashRequests = new Map<string, () => void>();
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
    for (const [marker, entered] of crashRequests) {
      if (command?.includes(marker)) {
        entered();
        return;
      }
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
    const admission = await fetch(
      `${server.origin}/session/${interruptedSession.id}/prompt_async?directory=${encodeURIComponent(fixture.root)}`,
      {
        method: "POST",
        signal: fixture.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: { providerID: "contract", modelID: "contract" },
          parts: [{ type: "text", text: "BLOCK_CONTRACT" }],
        }),
      },
    );
    assert.equal(
      admission.status,
      204,
      "HTTP acceptance must finish while the model turn is held open.",
    );
    await blockStarted;
    assert.equal(await api(`/session/${interruptedSession.id}/abort`, {}), true);
    await journal.waitFor(
      (event) =>
        event.payload.type === "session.idle" &&
        event.payload.properties.sessionID === interruptedSession.id,
    );
    const interruptedMessages = await api<NativeReply[]>(
      `/session/${interruptedSession.id}/message`,
    );
    assert(
      interruptedMessages.some((message) => message.info.error?.name === "MessageAbortedError"),
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

    // A native process cannot send per-session terminal events after it dies.
    // Its observable boundary is child exit plus failed in-flight requests.
    // Keep another Connection alive to prove the boundary is not global.
    const peer = await fixture.startServer(
      ["serve", "--port", "0", "--hostname", "127.0.0.1"],
      fixture.root,
      fixture.environment("peer", { OPENCODE_CONFIG_CONTENT: env.OPENCODE_CONFIG_CONTENT }),
      /opencode server listening on (http:\/\/[^\s]+)/,
    );
    const peerApi = <T>(route: string, body?: unknown) =>
      nativeJson<T>(peer.origin, route, fixture.root, fixture.signal, body);
    peerJournal = await nativeEventJournal(peer.origin, fixture.signal);
    const peerSession = await peerApi<{ id: string }>("/session", { title: "Other Connection" });
    const peerAnswering = peerApi<NativeReply>(`/session/${peerSession.id}/message`, {
      model: { providerID: "contract", modelID: "contract" },
      parts: [{ type: "text", text: "QUESTION_CONTRACT" }],
    });
    const peerAsked = await peerJournal.waitFor(
      (event) =>
        event.payload.type === "question.asked" &&
        event.payload.properties.sessionID === peerSession.id,
    );
    const affected = await Promise.all([create(), create()]);
    const pending = affected.map((session, index) => {
      const marker = `CRASH_BOUNDARY_${index}`;
      const entered = new Promise<void>((resolve) => crashRequests.set(marker, resolve));
      // Attach rejection handling before killing the process.
      const outcome = prompt(session.id, marker).then(
        () => ({ rejected: false }),
        () => ({ rejected: true }),
      );
      return { entered, outcome };
    });
    await Promise.all(pending.map((request) => request.entered));
    const exited = once(server.child, "exit", { signal: fixture.signal });
    assert.equal(server.child.kill("SIGKILL"), true);
    const [code, signal] = await exited;
    assert.equal(code, null);
    assert.equal(signal, "SIGKILL");
    assert.deepEqual(await Promise.all(pending.map((request) => request.outcome)), [
      { rejected: true },
      { rejected: true },
    ]);
    assert.equal(
      await peerApi(`/question/${peerAsked.payload.properties.id}/reply`, { answers: [["Blue"]] }),
      true,
    );
    assert.equal((await peerAnswering).info.error, undefined);
    const peerReply = await peerApi<NativeReply>(`/session/${peerSession.id}/message`, {
      model: { providerID: "contract", modelID: "contract" },
      parts: [{ type: "text", text: "Reply normally after the other Connection exits." }],
    });
    assert.equal(peerReply.info.error, undefined);
    assert(peerReply.parts.some((part) => part.text === "CONTRACT_DONE"));
    assert.equal(peer.child.exitCode, null);
    assert.equal(peer.child.signalCode, null);
    await peerJournal.close();
    peerJournal = undefined;
    await fixture.stop(server.child);
    await fixture.stop(peer.child);
  } finally {
    model.closeAllConnections();
    model.close();
    try {
      await journal?.close();
    } finally {
      try {
        await peerJournal?.close();
      } finally {
        await fixture.close();
      }
    }
  }
});
