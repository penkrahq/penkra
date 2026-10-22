import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { it } from "vitest";
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
  state?: { status: string };
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
  const model = http.createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text) as { messages: ModelMessage[] };
    const hasToolResult = body.messages.some((message) => message.role === "tool");
    if (!hasToolResult) {
      initialCount++;
      if (initialCount === 2) release();
      // Neither session can complete until both are genuinely in flight.
      await bothInitial;
    }
    const delta = hasToolResult
      ? { content: "CONTRACT_DONE" }
      : {
          tool_calls: [
            {
              index: 0,
              id: "call_proof",
              type: "function",
              function: { name: "proof", arguments: "{}" },
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
      `data: ${JSON.stringify({ id: "contract", object: "chat.completion.chunk", created: 1, model: "contract", choices: [{ index: 0, delta: {}, finish_reason: hasToolResult ? "stop" : "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`,
    );
  });
  try {
    const upstream = await listen(model);
    const calls = path.join(fixture.root, "calls.jsonl");
    const plugin = path.join(fixture.root, "proof.js");
    await writeFile(
      plugin,
      `import {appendFile} from 'node:fs/promises';
export const Proof = async () => ({tool:{proof:{description:'Return the native session and directory.',args:{},async execute(args,context){const row={sessionID:context.sessionID,directory:context.directory};await appendFile(${JSON.stringify(calls)},JSON.stringify(row)+'\\n');return JSON.stringify(row);}}}});
`,
    );
    const env = fixture.environment("source", {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        plugin: [pathToFileURL(plugin).href],
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
    const server = await fixture.startServer(
      ["serve", "--port", "0", "--hostname", "127.0.0.1"],
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
        const reply = await api<NativeMessage>(`/session/${session.id}/message`, directory, {
          model: { providerID: "contract", modelID: "contract" },
          parts: [{ type: "text", text: "Call proof, then finish." }],
        });
        assert.equal(reply.info.path?.cwd, directory);
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
    const actualCalls = (await readFile(calls, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { sessionID: string; directory: string });
    assert.equal(actualCalls.length, 2);
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
    try {
      await journal?.close();
    } finally {
      await fixture.close();
    }
  }
});
