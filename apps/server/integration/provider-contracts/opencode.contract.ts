import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { it } from "vitest";
import { ThreadId } from "@penkra/contracts";
import type { Part } from "@opencode-ai/sdk/v2";
import { relocateOpenCodeToolOutputFiles } from "../../src/provider/openCodeToolOutputFiles.ts";
import { preserveOpenCodeNativeSnapshots } from "../../src/provider/openCodeNativeSnapshots.ts";
import {
  importOpenCodeConversation,
  type OpenCodeConversationExport,
} from "../../src/provider/openCodeConversationTransfer.ts";
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
  projectID?: string;
}
interface NativePart {
  id?: string;
  type: string;
  snapshot?: string;
  hash?: string;
  tool?: string;
  url?: string;
  text?: string;
  state?: {
    status: string;
    attachments?: unknown[];
    metadata?: Record<string, unknown>;
    output?: string;
  };
}
interface NativeMessage {
  info: { id?: string; role: string; path?: { cwd: string } };
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
      `import {appendFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tool} from '@opencode-ai/plugin';
export const Proof = async () => ({tool:{proof:{description:'Return the native session and directory.',args:{marker:tool.schema.string().optional()},async execute(args,context){const row={sessionID:context.sessionID,directory:context.directory};await writeFile(path.join(context.directory,'proof.txt'),'changed by native tool\\n');await appendFile(${JSON.stringify(calls)},JSON.stringify(row)+'\\n');return JSON.stringify(row)+'\\n'+'NATIVE_SPILL_PROOF\\n'.repeat(4000);}}}});
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
        snapshot: true,
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
      nativeJson<T>(server.origin, route, directory, fixture.signal, body, method).catch(
        (cause) => {
          throw new Error(`${String(cause)}\n${server.diagnostics()}`, { cause });
        },
      );
    const sessions = await Promise.all(
      ["a", "b"].map(async (name) => {
        const directory = path.join(fixture.root, name);
        await mkdir(directory);
        await writeFile(path.join(directory, "proof.txt"), "original\n");
        await promisify(execFile)("git", ["init", "--quiet", directory], {
          signal: fixture.signal,
        });
        await promisify(execFile)("git", ["-C", directory, "add", "proof.txt"], {
          signal: fixture.signal,
        });
        await promisify(execFile)(
          "git",
          [
            "-C",
            directory,
            "-c",
            "user.name=Contract",
            "-c",
            "user.email=contract@example.invalid",
            "commit",
            "--quiet",
            "-m",
            "fixture",
          ],
          { signal: fixture.signal },
        );
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
    const snapshotHashes = exported.messages
      .flatMap((message) => message.parts)
      .flatMap((part) =>
        part.snapshot !== undefined
          ? [part.snapshot]
          : part.type === "patch" && part.hash !== undefined
            ? [part.hash]
            : [],
      );
    assert(snapshotHashes.length > 0, "The git-workspace turn must produce native snapshots.");
    assert.equal(typeof exported.info.projectID, "string");
    const snapshotRelative = path.join(
      "snapshot",
      exported.info.projectID!,
      createHash("sha1").update(source.directory).digest("hex"),
    );
    const sourceSnapshot = path.join(env.XDG_DATA_HOME!, "opencode", snapshotRelative);
    for (const hash of snapshotHashes)
      await promisify(execFile)(
        "git",
        ["--git-dir", sourceSnapshot, "cat-file", "-e", `${hash}^{tree}`],
        { signal: fixture.signal },
      );
    const proofPart = exported.messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === "tool" && part.tool === "proof");
    assert.equal(proofPart?.state?.metadata?.truncated, true);
    assert.equal(typeof proofPart.state.metadata.outputPath, "string");
    assert(
      (await readFile(proofPart.state.metadata.outputPath as string, "utf8")).includes(
        "NATIVE_SPILL_PROOF",
      ),
    );
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
    const spillPath = proofPart.state.metadata.outputPath as string;
    assert(spillPath.startsWith(path.join(fixture.root, "source") + path.sep));
    const importedProof = roundtrip.messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === "tool" && part.tool === "proof");
    assert.equal(importedProof?.state?.metadata?.outputPath, spillPath);
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
    // Import inserts new rows, but it does not update a part already present
    // in a previously used Connection. Prove the replacement boundary too.
    const sourceUser = updated.messages.find((message) => message.info.role === "user");
    const sourceText = sourceUser?.parts.find((part) => part.type === "text");
    assert(sourceUser?.info.id && sourceText?.id);
    await api(
      `/session/${source.session.id}/message/${sourceUser.info.id}/part/${sourceText.id}`,
      source.directory,
      { ...sourceText, text: "Updated existing native part." },
      "PATCH",
    );
    const changedPart = JSON.parse(
      (await fixture.command(["export", source.session.id], source.directory, env)).stdout,
    ) as ExportedSession;
    await writeFile(file, JSON.stringify(changedPart));
    await fixture.command(["import", file], target, targetEnv);
    const retainedOldPart = JSON.parse(
      (await fixture.command(["export", source.session.id], target, targetEnv)).stdout,
    ) as ExportedSession;
    assert.notDeepEqual(retainedOldPart.messages, changedPart.messages);
    assert.deepEqual(retainedOldPart.messages, updated.messages);
    await fixture.command(["--pure", "session", "delete", source.session.id], target, targetEnv);
    assert.equal(
      (
        await fetch(
          `${targetServer.origin}/session/${source.session.id}?directory=${encodeURIComponent(target)}`,
          { signal: fixture.signal },
        )
      ).status,
      404,
    );
    const repeatedDelete = await fetch(
      `${targetServer.origin}/session/${source.session.id}?directory=${encodeURIComponent(target)}`,
      { method: "DELETE", signal: fixture.signal },
    );
    assert.equal(repeatedDelete.status, 404);
    await fixture.command(["import", file], target, targetEnv);
    const replacedPart = await nativeJson<NativeMessage[]>(
      targetServer.origin,
      `/session/${source.session.id}/message`,
      target,
      fixture.signal,
    );
    assert.deepEqual(replacedPart, changedPart.messages);
    await fixture.command(["--pure", "session", "delete", source.session.id], target, targetEnv);
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
    const preservedEnv = fixture.environment("preserved");
    const preserved = {
      ...exported,
      messages: await Promise.all(
        exported.messages.map(async (message) => ({
          ...message,
          parts: await relocateOpenCodeToolOutputFiles(
            message.parts as Part[],
            path.join(fixture.root, "source"),
            path.join(
              preservedEnv.XDG_DATA_HOME!,
              "opencode",
              "thread-artifacts",
              source.session.id,
            ),
          ),
        })),
      ),
    };
    const preservedServer = await fixture.startServer(
      ["serve", "--port", "0", "--hostname", "127.0.0.1"],
      source.directory,
      preservedEnv,
      /opencode server listening on (http:\/\/[^\s]+)/,
    );
    const transfer = {
      conversation: exported as unknown as OpenCodeConversationExport,
      sourceDataRoot: path.join(env.XDG_DATA_HOME!, "opencode"),
      targetDataRoot: path.join(preservedEnv.XDG_DATA_HOME!, "opencode"),
      worktree: source.directory,
      temporaryRoot: path.join(fixture.root, "transfer"),
      env: preservedEnv,
      signal: fixture.signal,
      deleteTarget: async () => {
        const result = await fetch(
          `${preservedServer.origin}/session/${source.session.id}?directory=${encodeURIComponent(source.directory)}`,
          { method: "DELETE", signal: fixture.signal },
        );
        assert(result.ok || result.status === 404);
      },
      command: async (args: string[]) => ({
        ...(await fixture.command(args, source.directory, preservedEnv)),
        code: 0,
      }),
    };
    await importOpenCodeConversation(transfer);
    await importOpenCodeConversation(transfer);
    const targetSnapshot = path.join(preservedEnv.XDG_DATA_HOME!, "opencode", snapshotRelative);
    const snapshotCopy = {
      parts: exported.messages.flatMap((message) => message.parts) as Part[],
      projectID: exported.info.projectID!,
      worktree: source.directory,
      sourceDataRoot: path.join(env.XDG_DATA_HOME!, "opencode"),
      targetDataRoot: path.join(preservedEnv.XDG_DATA_HOME!, "opencode"),
      env: preservedEnv,
      signal: fixture.signal,
    };
    await preserveOpenCodeNativeSnapshots(snapshotCopy);
    await preserveOpenCodeNativeSnapshots(snapshotCopy);
    const preservedRoundtrip = JSON.parse(
      (await fixture.command(["export", source.session.id], source.directory, preservedEnv)).stdout,
    ) as ExportedSession;
    assert.deepEqual(preservedRoundtrip.messages, preserved.messages);
    const preservedPart = preservedRoundtrip.messages
      .flatMap((message) => message.parts)
      .find(
        (part): part is Extract<Part, { type: "tool" }> =>
          part.type === "tool" && part.tool === "proof",
      );
    const preservedPath =
      preservedPart?.state.status === "completed"
        ? preservedPart.state.metadata.outputPath
        : undefined;
    assert.equal(typeof preservedPath, "string");
    // Native export/import preserves an absolute spill reference, not its file.
    // Removing the old isolated data root therefore invalidates that reference.
    await rm(path.join(fixture.root, "source"), { recursive: true, force: true });
    await assert.rejects(readFile(spillPath), { code: "ENOENT" });
    assert((await readFile(preservedPath as string, "utf8")).includes("NATIVE_SPILL_PROOF"));
    for (const hash of snapshotHashes)
      await promisify(execFile)(
        "git",
        ["--git-dir", targetSnapshot, "cat-file", "-e", `${hash}^{tree}`],
        { signal: fixture.signal },
      );
    assert.equal(
      await readFile(path.join(source.directory, "proof.txt"), "utf8"),
      "changed by native tool\n",
    );
    const firstUser = exported.messages.find((message) => message.info.role === "user");
    assert(firstUser?.info.id);
    await nativeJson(
      preservedServer.origin,
      `/session/${source.session.id}/revert`,
      source.directory,
      fixture.signal,
      { messageID: firstUser.info.id },
    );
    assert.equal(await readFile(path.join(source.directory, "proof.txt"), "utf8"), "original\n");
    await fixture.stop(preservedServer.child);
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
