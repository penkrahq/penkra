import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { it } from "vitest";
import { ThreadId } from "@penkra/contracts";
import { makeAgentGatewaySessionRegistry } from "../../src/agentGateway/Layers/AgentGatewaySessionRegistry.ts";
import {
  PENKRA_EXEC_COMMAND_DESCRIPTION,
  PENKRA_EXEC_COMMAND_INPUT_SCHEMA,
  PENKRA_EXEC_COMMAND_NAME,
} from "../../src/agentGateway/hostToolContract.ts";
import { openCodeGatewayPluginSource } from "../../src/provider/openCodeGatewayPlugin.ts";
import { extractBearerToken } from "../../src/agentGateway/bearerToken.ts";
import {
  contractFixture,
  listen,
  nativeJson,
  nativeEventJournal,
  repositoryRoot,
} from "./support.ts";

interface NativeSession {
  id: string;
  directory: string;
}
interface NativePart {
  type: string;
  tool?: string;
  url?: string;
  text?: string;
  state?: { status: string; attachments?: unknown[] };
}
interface NativeMessage {
  info: { role: string; path?: { cwd: string } };
  parts: NativePart[];
}
interface ExportedSession {
  info: NativeSession;
  messages: NativeMessage[];
}
interface ModelMessage {
  role: string;
}

it("routes simultaneous sessions by native sessionID/directory and preserves tools/images through export/import", async () => {
  const fixture = await contractFixture("opencode");
  let initialCount = 0;
  let release!: () => void;
  const bothInitial = new Promise<void>((resolve) => {
    release = resolve;
  });
  let journal: Awaited<ReturnType<typeof nativeEventJournal>> | undefined;
  const registry = makeAgentGatewaySessionRegistry();
  const processToken = registry.processes.issue("opencode");
  const nativeDirectories = new Map<string, string>();
  const gatewayCalls: Array<{ threadId: string; sessionID: string; directory: string }> = [];
  const imageBytes = (
    await readFile(path.join(repositoryRoot, "apps/marketing/public/favicon-32x32.png"))
  ).toString("base64");
  const gateway = http.createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text) as { id: string; method: string };
    const token = extractBearerToken(request.headers.authorization);
    const sessionID = request.headers["x-penkra-native-session-id"];
    const childToken =
      token && typeof sessionID === "string" ? registry.processes.resolve(token, sessionID) : null;
    const identity = childToken ? registry.verify(childToken) : null;
    const probe =
      token && typeof sessionID === "string" && registry.processes.isProbe(token, sessionID);
    if ((!identity && !probe) || typeof sessionID !== "string") {
      response.writeHead(401);
      response.end(JSON.stringify({ error: { message: "Unregistered native session" } }));
      return;
    }
    if (body.method === "initialize") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { instructions: probe ? "" : "GATEWAY_MANUAL_CONTRACT" },
        }),
      );
      return;
    }
    if (!identity) {
      response.writeHead(401);
      response.end(JSON.stringify({ error: { message: "Probes cannot use host tools" } }));
      return;
    }
    const directory = nativeDirectories.get(sessionID)!;
    gatewayCalls.push({ threadId: identity.threadId, sessionID, directory });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({ threadId: identity.threadId, sessionID, directory }),
            },
            { type: "image", mimeType: "image/png", data: imageBytes },
          ],
        },
      }),
    );
  });
  const model = http.createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text) as {
      messages: ModelMessage[];
      tools?: Array<{ function: { name: string } }>;
    };
    const probe = JSON.stringify(body.messages).includes("PROBE_CONTRACT");
    assert.equal(
      JSON.stringify(body.messages.filter((message) => message.role === "system")).includes(
        "GATEWAY_MANUAL_CONTRACT",
      ),
      !probe,
    );
    if (probe) assert(!body.tools?.some((tool) => tool.function.name === PENKRA_EXEC_COMMAND_NAME));
    const hasToolResult = body.messages.some((message) => message.role === "tool");
    if (!hasToolResult && !probe) {
      initialCount++;
      if (initialCount === 2) release();
      // Neither session can complete until both are genuinely in flight.
      await bothInitial;
    }
    const delta =
      hasToolResult || probe
        ? { content: probe ? "PROBE_OK" : "CONTRACT_DONE" }
        : {
            tool_calls: [
              {
                index: 0,
                id: "call_proof",
                type: "function",
                function: { name: "proof", arguments: "{}" },
              },
              {
                index: 1,
                id: "call_gateway",
                type: "function",
                function: {
                  name: PENKRA_EXEC_COMMAND_NAME,
                  arguments: JSON.stringify({ command: "identity" }),
                },
              },
            ],
          };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const part of [{ role: "assistant", content: "" }, delta]) {
      res.write(
        `data: ${JSON.stringify({ id: "contract", object: "chat.completion.chunk", created: 1, model: "contract", choices: [{ index: 0, delta: part, finish_reason: null }] })}\n\n`,
      );
    }
    res.end(
      `data: ${JSON.stringify({ id: "contract", object: "chat.completion.chunk", created: 1, model: "contract", choices: [{ index: 0, delta: {}, finish_reason: hasToolResult || probe ? "stop" : "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`,
    );
  });
  try {
    const upstream = await listen(model);
    const gatewayOrigin = await listen(gateway);
    const calls = path.join(fixture.root, "calls.jsonl");
    const plugin = path.join(fixture.root, "source/config/opencode/plugins/proof.js");
    await mkdir(path.dirname(plugin), { recursive: true });
    await writeFile(
      plugin,
      `import {appendFile} from 'node:fs/promises';
import {tool} from '@opencode-ai/plugin';
export const Proof = async () => ({tool:{proof:{description:'Return the native session and directory.',args:{marker:tool.schema.string().optional()},async execute(args,context){const row={sessionID:context.sessionID,directory:context.directory};await appendFile(${JSON.stringify(calls)},JSON.stringify(row)+'\\n');return JSON.stringify(row);}}}});
`,
    );
    const gatewayPlugin = path.join(path.dirname(plugin), "gateway.js");
    await writeFile(
      gatewayPlugin,
      openCodeGatewayPluginSource([
        {
          name: PENKRA_EXEC_COMMAND_NAME,
          description: PENKRA_EXEC_COMMAND_DESCRIPTION,
          inputSchema: PENKRA_EXEC_COMMAND_INPUT_SCHEMA,
        },
      ]),
    );
    const env = fixture.environment("source", {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        plugin: [pathToFileURL(plugin).href, pathToFileURL(gatewayPlugin).href],
        model: "contract/contract",
        small_model: "contract/contract",
        provider: {
          contract: {
            npm: "@ai-sdk/openai-compatible",
            name: "Contract",
            options: { baseURL: `${upstream}/v1`, apiKey: "contract-only" },
            models: {
              contract: {
                name: "contract",
                limit: { context: 32000, output: 4096 },
                attachment: true,
              },
            },
          },
        },
        permission: { "*": "allow" },
      }),
    });
    env.PENKRA_GATEWAY_URL = `${gatewayOrigin}/mcp`;
    env.PENKRA_GATEWAY_PROCESS_TOKEN = processToken;
    const server = await fixture.startServer(
      ["serve", "--print-logs", "--port", "0", "--hostname", "127.0.0.1"],
      fixture.root,
      env,
      /opencode server listening on (http:\/\/[^\s]+)/,
    );
    journal = await nativeEventJournal(server.origin, fixture.signal);
    const api = <T>(route: string, directory: string, body?: unknown, method?: string) =>
      nativeJson<T>(server.origin, route, directory, fixture.signal, body, method);
    const sessions = await Promise.all(
      ["a", "b"].map(async (name) => {
        const directory = path.join(fixture.root, name);
        await mkdir(directory);
        const session = await api<NativeSession>("/session", directory, {
          title: `Contract ${name}`,
        });
        const identity = registry.issue(ThreadId.makeUnsafe(`thread-${name}`), "opencode");
        registry.processes.register(processToken, session.id, identity.token);
        nativeDirectories.set(session.id, directory);
        const reply = await api<NativeMessage>(`/session/${session.id}/message`, directory, {
          model: { providerID: "contract", modelID: "contract" },
          parts: [{ type: "text", text: "Call proof, then finish." }],
        });
        assert.equal(reply.info.path?.cwd, directory);
        const history = await api<NativeMessage[]>(`/session/${session.id}/message`, directory);
        const toolParts = history
          .flatMap((message) => message.parts)
          .filter((part) => part.type === "tool");
        const failedTools = toolParts.filter((part) => part.state?.status === "error");
        assert.equal(failedTools.length, 0, JSON.stringify(failedTools));
        assert.equal(
          toolParts.find((part) => part.tool === PENKRA_EXEC_COMMAND_NAME)?.state?.attachments
            ?.length,
          1,
        );
        assert(reply.parts.some((part) => part.type === "text" && part.text === "CONTRACT_DONE"));
        return { session, directory };
      }),
    );
    assert.equal(initialCount, 2);
    for (const { session } of sessions) {
      await journal.waitFor(
        (event) =>
          event.payload.type === "session.idle" &&
          event.payload.properties.sessionID === session.id,
      );
      const terminalIndex = journal.events.findIndex(
        (event) =>
          event.payload.type === "message.updated" &&
          (event.payload.properties.info as { sessionID?: string; finish?: string } | undefined)
            ?.sessionID === session.id &&
          (event.payload.properties.info as { finish?: string }).finish === "stop",
      );
      const idleIndex = journal.events.findIndex(
        (event) =>
          event.payload.type === "session.idle" &&
          event.payload.properties.sessionID === session.id,
      );
      assert(
        terminalIndex >= 0 && idleIndex > terminalIndex,
        "Native message completion must precede session.idle.",
      );
    }
    const actualCalls = (
      await readFile(calls, "utf8").catch((cause) => {
        throw new Error(server.diagnostics(), { cause });
      })
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { sessionID: string; directory: string });
    assert.equal(actualCalls.length, 2);
    assert.equal(gatewayCalls.length, 2);
    const probe = await api<NativeSession>("/session", fixture.root, {
      title: "Connectivity probe",
      permission: [{ permission: "*", pattern: "*", action: "deny" }],
    });
    const unregisterProbe = registry.processes.registerProbe(processToken, probe.id);
    try {
      const result = await api<NativeMessage>(`/session/${probe.id}/message`, fixture.root, {
        model: { providerID: "contract", modelID: "contract" },
        tools: { "*": false },
        parts: [{ type: "text", text: "PROBE_CONTRACT" }],
      });
      assert(result.parts.some((part) => part.type === "text" && part.text === "PROBE_OK"));
      assert(!result.parts.some((part) => part.type === "tool"));
      assert.equal(gatewayCalls.length, 2);
      await api(`/session/${probe.id}`, fixture.root, undefined, "DELETE");
    } finally {
      unregisterProbe();
    }
    for (const { session, directory } of sessions) {
      const call = gatewayCalls.find((entry) => entry.sessionID === session.id);
      assert.equal(call?.directory, directory);
      assert.equal(call?.threadId, `thread-${path.basename(directory)}`);
    }
    for (const { session, directory } of sessions)
      assert.deepEqual(
        actualCalls.find((call) => call.sessionID === session.id),
        { sessionID: session.id, directory },
      );

    const source = sessions[0]!;
    const image = `data:image/png;base64,${(await readFile(path.join(repositoryRoot, "apps/marketing/public/favicon-32x32.png"))).toString("base64")}`;
    await api(`/session/${source.session.id}/message`, source.directory, {
      noReply: true,
      parts: [
        { type: "text", text: "Keep this attachment." },
        { type: "file", mime: "image/png", filename: "proof.png", url: image },
      ],
    });
    const exported = JSON.parse(
      (await fixture.command(["export", source.session.id], source.directory, env)).stdout,
    ) as ExportedSession;
    assert(
      exported.messages.some((message) =>
        message.parts.some(
          (part) =>
            part.type === "tool" && part.tool === "proof" && part.state?.status === "completed",
        ),
      ),
    );
    assert(
      exported.messages.some((message) =>
        message.parts.some((part) => part.type === "file" && part.url === image),
      ),
    );
    const file = path.join(fixture.root, "export.json");
    await writeFile(file, JSON.stringify(exported));
    const target = path.join(fixture.root, "target-workspace");
    await mkdir(target);
    const targetEnv = fixture.environment("target");
    const imported = await fixture.command(["import", file], target, targetEnv);
    assert(imported.stdout.includes(`Imported session: ${source.session.id}`));
    const roundtrip = JSON.parse(
      (await fixture.command(["export", source.session.id], target, targetEnv)).stdout,
    ) as ExportedSession;
    assert.deepEqual(roundtrip.messages, exported.messages);
    assert.equal(roundtrip.info.directory, target);
    const targetServer = await fixture.startServer(
      ["serve", "--port", "0", "--hostname", "127.0.0.1"],
      target,
      targetEnv,
      /opencode server listening on (http:\/\/[^\s]+)/,
    );
    await nativeJson<NativeMessage[]>(
      targetServer.origin,
      `/session/${source.session.id}/message`,
      target,
      fixture.signal,
    );
    // Returning to a previously used Connection must copy the latest conversation,
    // not retain its older version or duplicate already-imported messages.
    await api(`/session/${source.session.id}/message`, source.directory, {
      noReply: true,
      parts: [{ type: "text", text: "A newer message after the first copy." }],
    });
    const updated = JSON.parse(
      (await fixture.command(["export", source.session.id], source.directory, env)).stdout,
    ) as ExportedSession;
    await writeFile(file, JSON.stringify(updated));
    await fixture.command(["import", file], target, targetEnv);
    const replaced = JSON.parse(
      (await fixture.command(["export", source.session.id], target, targetEnv)).stdout,
    ) as ExportedSession;
    assert.deepEqual(replaced.messages, updated.messages);
    const liveTarget = await nativeJson<NativeMessage[]>(
      targetServer.origin,
      `/session/${source.session.id}/message`,
      target,
      fixture.signal,
    );
    assert.deepEqual(liveTarget, updated.messages);
    await fixture.stop(targetServer.child);
    assert.equal(
      await api(`/session/${source.session.id}`, source.directory, undefined, "DELETE"),
      true,
    );
    const response = await fetch(
      `${server.origin}/session/${source.session.id}?directory=${encodeURIComponent(source.directory)}`,
      { signal: fixture.signal },
    );
    assert.equal(response.status, 404);
    // Deleting one native session leaves its peer available in the same process.
    assert.equal(
      (await api<NativeSession>(`/session/${sessions[1]!.session.id}`, sessions[1]!.directory)).id,
      sessions[1]!.session.id,
    );
    await journal.close();
    journal = undefined;
    await fixture.stop(server.child);
  } finally {
    release();
    model.closeAllConnections();
    model.close();
    gateway.closeAllConnections();
    gateway.close();
    registry.processes.revoke(processToken);
    try {
      await journal?.close();
    } finally {
      await fixture.close();
    }
  }
});
