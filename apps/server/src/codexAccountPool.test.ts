import { ConnectionRateLimitsLive } from "./providerUsage/ConnectionRateLimits.ts";
import { NativeStorageTestLayer } from "./provider/nativeStorage.test-support.ts";
import { ProviderAuthCircuitsLive } from "./provider/providerAuthCircuit.ts";
// FILE: codexAccountPool.test.ts
// Purpose: Exercise account transports with real children and gateway leases.

import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FolderId,
  ProviderInstallationId,
  ProviderConnectionId,
  ThreadId,
  type OrchestrationThreadShell,
} from "@penkra/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, Option, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import * as SqlClient from "effect/sql/SqlClient";
import { expect, it } from "vitest";
import { prepareManagedCodexProfileConfig } from "./codexProcessEnv";
import { CodexAppServerManager } from "./codexAppServerManager";
import { makeAgentGatewaySessionRegistry } from "./agentGateway/Layers/AgentGatewaySessionRegistry";
import { makeAgentGatewayCredentials } from "./agentGateway/Layers/AgentGatewayCredentials";
import { AgentGatewaySessionRegistry } from "./agentGateway/Services/AgentGatewaySessionRegistry";
import { makeAgentGatewayMcpTransport } from "./agentGateway/mcpTransport";
import type { ThreadReadsShape } from "./cleanCore/ThreadReads";
import { ServerConfig } from "./config";
import { makeCodexAdapterLive } from "./provider/Layers/CodexAdapter";
import { CodexAdapter } from "./provider/Services/CodexAdapter";
import { makeOpenCodeAdapterLive } from "./provider/Layers/OpenCodeAdapter";
import { AgentGatewayToolBridge } from "./agentGateway/Services/AgentGatewayToolBridge.ts";
import {
  PENKRA_EXEC_COMMAND_NAME,
  PENKRA_EXEC_COMMAND_DESCRIPTION,
  PENKRA_EXEC_COMMAND_INPUT_SCHEMA,
} from "./agentGateway/hostToolContract.ts";
import { OpenCodeAdapter } from "./provider/Services/OpenCodeAdapter";
import { makeOpenCodeRuntimeLive, OpenCodeRuntime } from "./provider/opencodeRuntime";
import { ProviderAdapterRegistry } from "./provider/Services/ProviderAdapterRegistry";
import { makeManagedProviderServiceLive } from "./provider/Layers/ProviderService";
import { ProviderLaunchResolverLive } from "./provider/Layers/ProviderLaunchResolver";
import { ProviderConnectionRepository } from "./persistence/Services/ProviderConnections";
import { ProviderInstallationRepository } from "./persistence/Services/ProviderInstallations";
import { ProviderCredentialBroker } from "./provider/providerCredentialBroker";
import { ProviderSessionDirectoryLive } from "./provider/Layers/ProviderSessionDirectory";
import { AnalyticsService } from "./telemetry/Services/AnalyticsService";
import * as NodeSqliteClient from "./persistence/NodeSqliteClient";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite";
import { runMigrations } from "./persistence/Migrations";
import { createThreadFixture } from "./cleanCore/threadFixtures";
import { makeThreadPublisher } from "./cleanCore/threadStore";
import { makeThreadLifecycle } from "./cleanCore/threadLifecycle";
import { ThreadPublisher } from "./cleanCore/ThreadPublisher";
import { ThreadSender } from "./cleanCore/ThreadSender";
import { ProviderService } from "./provider/Services/ProviderService";
import { ProviderTurnSelectionResolver } from "./provider/Services/ProviderTurnSelectionResolver";
import { providerNativeStateRoot } from "./provider/providerNativeStatePaths";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function withPool(run: (fixture: Awaited<ReturnType<typeof createPool>>) => Promise<void>) {
  const fixture = await createPool();
  try {
    await run(fixture);
  } finally {
    await fixture.manager.stopAll();
    fixture.server.closeAllConnections();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
    await rm(fixture.root, { recursive: true, force: true });
  }
}

async function createPool() {
  const root = await mkdtemp(join(tmpdir(), "penkra-codex-account-pool-"));
  const registry = makeAgentGatewaySessionRegistry();
  const credentials = await Effect.runPromise(
    makeAgentGatewayCredentials.pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(AgentGatewaySessionRegistry, registry),
      Effect.provideService(ServerConfig, {
        stateDir: root,
        host: "127.0.0.1",
        port: 0,
      } as typeof ServerConfig.Service),
    ),
  );
  const shell = (id: string) =>
    ({
      id,
      archivedAt: null,
      session: null,
      modelSelection: { provider: "codex", model: "gpt-5.5" },
    }) as OrchestrationThreadShell;
  const gateway = makeAgentGatewayMcpTransport({
    stateDir: root,
    credentials,
    snapshotQuery: {
      getThreadShellById: (id: ThreadId) => Effect.succeed(Option.some(shell(id))),
    } as unknown as ThreadReadsShape,
    requireThreadShell: (id) => Effect.succeed(shell(id)),
    instructions: "Pool attribution test",
    tools: [
      {
        definition: {
          name: "identity",
          description: "Calling thread",
          inputSchema: { type: "object", properties: {} },
        },
        requiredCapability: "thread:read",
        handler: (_args, context) =>
          Effect.succeed({ content: [{ type: "text", text: context.callerThreadId }] }),
      },
    ],
  });
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const result = await Effect.runPromise(
      gateway({ authorizationHeader: request.headers.authorization, body: JSON.parse(body) }),
    );
    response.writeHead(result.status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(result.body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing gateway port");
  credentials.setListeningPort(address.port);
  const script = join(root, "fake-codex.cjs");
  const trace = join(root, "processes.jsonl");
  await writeFile(
    script,
    `
const fs=require('node:fs'),rl=require('node:readline');
const configs=new Map(),tools=new Map(),turns=new Map(); let next=0,autoClose=false;
const out=message=>process.stdout.write(JSON.stringify(message)+'\\n');
fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({pid:process.pid,event:'spawn',unloadImmediate:fs.readFileSync(process.env.CODEX_HOME+'/config.toml','utf8').includes('thread_unload_delay_secs = 0')})+'\\n');
rl.createInterface({input:process.stdin}).on('line',async line=>{
  const request=JSON.parse(line); if(request.id===undefined)return;
  if(request.method===undefined){tools.get(request.id)?.(request.result);tools.delete(request.id);return;}
  let result={};const p=request.params;
  if(request.method==='initialize')fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({pid:process.pid,event:'initialize'})+'\\n');
  if(request.method==='account/read')result={account:process.env.CODEX_HOME.endsWith('signed-out')?null:{type:'chatgpt',email:'fixture@example.test',planType:'pro'},requiresOpenaiAuth:true,workspaceRouting:null};
  if(request.method==='account/rateLimits/read'){
    fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({pid:process.pid,event:'usage'})+'\\n');
    if(process.env.CODEX_HOME.endsWith('usage-error')){out({id:request.id,error:{code:-32000,message:'Usage rejected'}});return;}
    result={rateLimits:{primary:{usedPercent:process.env.CODEX_HOME.endsWith('account-b')?67:12,windowDurationMins:300,resetsAt:2000000000},secondary:null,credits:{hasCredits:true,unlimited:false,balance:'10'},planType:'pro',limitId:'codex'},rateLimitsByLimitId:null,ordinaryUsageAllowed:true};
  }
  if(request.method==='thread/start'||request.method==='thread/resume'){
    const id=p.threadId||'native-'+(++next);configs.set(id,p.config);result={thread:{id,status:'idle'}};
  }
  if(request.method==='model/list')result={data:[]};
  if(request.method==='mcpServerStatus/list')result={data:[],nextCursor:null};
  if(request.method==='plugin/list')result={marketplaces:[]};
  if(request.method==='turn/start'){
    result={turn:{id:'turn-'+(++next),status:'inProgress'}};turns.set(p.threadId,result.turn.id);
    out({method:'turn/started',params:{threadId:p.threadId,turn:result.turn}});
  }
  if(request.method==='test/mcp'){
    const c=configs.get(p.threadId)['mcp_servers.penkra'];
    const response=await fetch(c.url,{method:'POST',headers:{...c.http_headers,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:request.id,method:'tools/call',params:{name:'identity',arguments:{}}})});
    result=await response.json();
  }
  if(request.method==='test/native'){
    const id='tool-'+(++next);
    const reply=new Promise(resolve=>tools.set(id,resolve));
    out({id,method:'item/tool/call',params:{threadId:p.threadId,turnId:turns.get(p.threadId),namespace:null,tool:'identity',arguments:{}}});
    result=await reply;
  }
  if(request.method==='test/close')out({method:'thread/closed',params:{threadId:p.threadId}});
  if(request.method==='test/autoClose')autoClose=true;
  if(request.method==='thread/unsubscribe'&&autoClose)out({method:'thread/closed',params:{threadId:p.threadId}});
  if(request.method==='test/exit')process.exit(7);
  out({id:request.id,result});
});
`,
  );
  const binaryPath = join(root, "codex");
  await writeFile(
    binaryPath,
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`,
    { mode: 0o755 },
  );
  const manager = new CodexAppServerManager(undefined, {
    stateDir: root,
    agentGatewayHostTool: {
      acquireSessionLease: (id, generation) => {
        const connection = credentials.connectionForThread(id, "codex", generation);
        return {
          connection,
          release: () => credentials.revokeSessionToken(connection.bearerToken),
        };
      },
      requireNativeSurface: () => ({
        definitions: [],
        invoke: async (input) => {
          const result = await Effect.runPromise(
            gateway({
              authorizationHeader: "Bearer " + input.bearerToken,
              body: {
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: { name: "identity", arguments: {} },
              },
            }),
          );
          return (result.body as { result: { content: { type: "text"; text: string }[] } }).result;
        },
      }),
    },
  });
  const credentialGenerations = new Map<string, number>();
  let nextCredentialGeneration = 0;
  const retireCredentials = (account: string) => credentialGenerations.delete(account);
  const launch = async (account: string) => {
    const generation = credentialGenerations.get(account) ?? ++nextCredentialGeneration;
    credentialGenerations.set(account, generation);
    const profileRoot = join(root, account);
    await mkdir(profileRoot, { recursive: true });
    await prepareManagedCodexProfileConfig({
      env: { CODEX_HOME: profileRoot },
      sourceHomePath: profileRoot,
    });
    return {
      binaryPath,
      profileRoot,
      nativeStateRoot: join(root, account + "-native"),
      isolationKey: `${account}:${generation}`,
      assertCurrentCredentials: Effect.suspend(() =>
        credentialGenerations.get(account) === generation
          ? Effect.void
          : Effect.fail(new Error("Credential retired")),
      ),
      connectionId: ProviderConnectionId.make(account),
      childEnvironment: (env: NodeJS.ProcessEnv) => ({
        ...env,
        CODEX_HOME: profileRoot,
        CODEX_SQLITE_HOME: join(profileRoot, "sqlite"),
      }),
    };
  };
  const input = async (id: string, account = "account-a") => ({
    threadId: ThreadId.make(id),
    cwd: root,
    model: "gpt-5.5",
    runtimeMode: "full-access" as const,
    managedLaunch: await launch(account),
  });
  const command = (threadId: string, method: string, params: unknown) => {
    const internals = manager as unknown as {
      sessions: Map<string, { transport: unknown }>;
      sendRequest: (
        transport: unknown,
        owner: null,
        method: string,
        params: unknown,
      ) => Promise<unknown>;
    };
    const context = internals.sessions.get(threadId);
    if (!context) throw new Error("Missing test thread " + threadId);
    return internals.sendRequest(context.transport, null, method, params);
  };
  const events = () =>
    readFile(trace, "utf8").then((text) =>
      text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    );
  return {
    root,
    manager,
    server,
    credentials,
    input,
    launch,
    command,
    events,
    binaryPath,
    retireCredentials,
  };
}

it("coalesces concurrent starts and discovery per account and attributes interleaved MCP calls", () =>
  withPool(async (f) => {
    const [a, b] = await Promise.all([f.input("a"), f.input("b")]);
    const [sa, sb] = await Promise.all([
      f.manager.startSession(a),
      f.manager.startSession(b),
      f.manager.loadCatalog({ cwd: f.root, managedLaunch: a.managedLaunch, kinds: ["models"] }),
    ]);
    const nativeA = (sa.resumeCursor as { threadId: string }).threadId;
    const nativeB = (sb.resumeCursor as { threadId: string }).threadId;
    const calls = await Promise.all([
      f.command("a", "test/mcp", { threadId: nativeA }),
      f.command("b", "test/mcp", { threadId: nativeB }),
      f.command("a", "test/mcp", { threadId: nativeA }),
      f.command("b", "test/mcp", { threadId: nativeB }),
    ]);
    expect(
      calls.map(
        (result) => (result as { result: { content: { text: string }[] } }).result.content[0]!.text,
      ),
    ).toEqual(["a", "b", "a", "b"]);
    await Promise.all([
      f.manager.sendTurn({ threadId: a.threadId, input: "A tools" }),
      f.manager.sendTurn({ threadId: b.threadId, input: "B tools" }),
    ]);
    const nativeCalls = await Promise.all([
      f.command("a", "test/native", { threadId: nativeA }),
      f.command("b", "test/native", { threadId: nativeB }),
    ]);
    expect(
      nativeCalls.map(
        (result) => (result as { contentItems: { text: string }[] }).contentItems[0]!.text,
      ),
    ).toEqual(["a", "b"]);
    expect((await f.events()).filter((event) => event.event === "spawn")).toHaveLength(1);
    expect((await f.events()).filter((event) => event.event === "initialize")).toHaveLength(1);
    expect((await f.events())[0].unloadImmediate).toBe(true);
    await f.manager.startSession(await f.input("c", "account-b"));
    expect((await f.events()).filter((event) => event.event === "spawn")).toHaveLength(2);
    f.retireCredentials("account-a");
    await f.manager.stopAccount(ProviderConnectionId.make("account-a"));
    expect(f.manager.hasSession(a.threadId)).toBe(false);
    expect(f.manager.hasSession(b.threadId)).toBe(false);
    expect(f.manager.hasSession(ThreadId.make("c"))).toBe(true);
    await expect(
      f.manager.startSession({ ...a, threadId: ThreadId.make("late-old-profile") }),
    ).rejects.toThrow();
    const refreshed = await f.input("reauthenticated-a", "account-a");
    expect(refreshed.managedLaunch.profileRoot).toBe(a.managedLaunch.profileRoot);
    await f.manager.startSession(refreshed);
    expect(f.manager.hasSession(refreshed.threadId)).toBe(true);
    await f.manager.sendTurn({
      threadId: ThreadId.make("c"),
      input: "Sibling account still works",
    });
  }));

it("fails the current acquisition instead of automatically restarting a closed process", () =>
  withPool(async (f) => {
    const first = await f.input("before-close");
    await f.manager.startSession(first);
    const internals = f.manager as unknown as {
      sessions: Map<string, { transport: { protocolClosed: boolean; protocolFailure: Error } }>;
    };
    const transport = internals.sessions.get(String(first.threadId))!.transport;
    transport.protocolClosed = true;
    transport.protocolFailure = new Error("Controlled closed transport");
    await expect(f.manager.startSession(await f.input("same-acquisition"))).rejects.toThrow();
    expect((await f.events()).filter((event) => event.event === "spawn")).toHaveLength(1);
    await f.manager.startSession(await f.input("next-explicit-start"));
    expect((await f.events()).filter((event) => event.event === "spawn")).toHaveLength(2);
  }));

it("waits for native close, keeps a sibling working, and retains the program at zero references", () =>
  withPool(async (f) => {
    const a = await f.input("a");
    const b = await f.input("b");
    const sa = await f.manager.startSession(a);
    const sb = await f.manager.startSession(b);
    let closed = false;
    const stopping = f.manager.stopSession(a.threadId).then(() => {
      closed = true;
    });
    await f.command("b", "test/barrier", {});
    expect(closed).toBe(false);
    await f.manager.sendTurn({ threadId: b.threadId, input: "Sibling still works" });
    await f.command("b", "test/close", {
      threadId: (sa.resumeCursor as { threadId: string }).threadId,
    });
    await stopping;
    const stopB = f.manager.stopSession(b.threadId);
    await f.command("b", "test/close", {
      threadId: (sb.resumeCursor as { threadId: string }).threadId,
    });
    await stopB;
    await f.manager.startSession(await f.input("c"));
    expect((await f.events()).filter((event) => event.event === "spawn")).toHaveLength(1);
  }));

it("process exit rejects a pending native close without waiting for a deadline", () =>
  withPool(async (f) => {
    const a = await f.input("a");
    const b = await f.input("b");
    await f.manager.startSession(a);
    await f.manager.startSession(b);
    const stopping = f.manager.stopSession(a.threadId);
    const failedClose = expect(stopping).rejects.toThrow("process");
    const exiting = f.command("b", "test/exit", {});
    await expect(exiting).rejects.toThrow("process");
    await failedClose;
    expect(f.manager.listSessions()).toEqual([]);
  }));

it("process exit rejects an in-flight authentication probe without advancing clocks", () =>
  withPool(async (f) => {
    const a = await f.input("a");
    await f.manager.startSession(a);
    const probe = f.manager.probeResponses({
      cwd: f.root,
      model: "gpt-5.5",
      managedLaunch: a.managedLaunch,
    });
    const failedProbe = expect(probe).rejects.toThrow("process");
    // Requests share one stdio stream; the barrier follows the probe's turn/start.
    await f.command("a", "test/barrier", {});
    await expect(f.command("a", "test/exit", {})).rejects.toThrow("process");
    await failedProbe;
  }));

const at = "2026-10-11T00:00:00.000Z";
function seedCanonicalThread(id: ThreadId) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT OR IGNORE INTO projection_folders (folder_id, space_id, title, workspace_root, default_model_selection_json, created_at, updated_at) VALUES ('pool-folder', 'penkra-personal', 'Pool', NULL, NULL, ${at}, ${at})`;
    yield* createThreadFixture(sql, {
      threadId: id,
      folderId: FolderId.make("pool-folder"),
      title: "Pool",
      modelSelection: { provider: "codex", model: "gpt-5.5" },
      runtimeMode: "full-access",
      connection: { kind: "selected", connectionId: null },
      creator: { kind: "user" },
      createdAt: at,
    });
  });
}

it("ThreadLifecycle removes native files only after thread/closed", () =>
  withPool(async (f) => {
    const a = await f.input("a");
    const b = await f.input("b");
    const session = await f.manager.startSession(a);
    await f.manager.startSession(b);
    const nativePath = providerNativeStateRoot(f.root, "delete-native");
    await mkdir(nativePath, { recursive: true });
    await writeFile(join(nativePath, "conversation.jsonl"), "conversation");
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* runMigrations();
        yield* seedCanonicalThread(a.threadId);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE threads SET native_state_id = 'delete-native' WHERE id = ${a.threadId}`;
        let enteredStop!: () => void;
        const stopEntered = new Promise<void>((resolve) => {
          enteredStop = resolve;
        });
        const lifecycle = yield* makeThreadLifecycle.pipe(
          Effect.provide(NativeStorageTestLayer),
          Effect.provideService(ThreadPublisher, makeThreadPublisher()),
          Effect.provideService(
            ProviderTurnSelectionResolver,
            {} as typeof ProviderTurnSelectionResolver.Service,
          ),
          Effect.provideService(ThreadSender, {
            runExclusive: (_id, action) => action,
          } as typeof ThreadSender.Service),
          Effect.provideService(ProviderService, {
            stop: () =>
              Effect.tryPromise(() => {
                enteredStop();
                return f.manager.stopSession(a.threadId);
              }),
          } as unknown as typeof ProviderService.Service),
          Effect.provideService(ServerConfig, { stateDir: f.root } as typeof ServerConfig.Service),
        );
        yield* Effect.tryPromise(async () => {
          const deleting = Effect.runPromise(
            lifecycle.update({
              action: "delete",
              threadId: a.threadId,
              deletedAt: at,
              updatedAt: at,
            }),
          );
          await stopEntered;
          await f.command("b", "test/barrier", {});
          expect(existsSync(nativePath)).toBe(true);
          await f.manager.sendTurn({
            threadId: b.threadId,
            input: "Sibling still works while deletion waits",
          });
          await f.command("b", "test/close", {
            threadId: (session.resumeCursor as { threadId: string }).threadId,
          });
          await deleting;
          expect(existsSync(nativePath)).toBe(false);
        });
        expect(
          (yield* sql`SELECT deleted_at FROM threads WHERE id = ${a.threadId}`)[0]!.deleted_at,
        ).toBe(at);
      }).pipe(Effect.provide(NodeSqliteClient.layerMemory()), Effect.scoped),
    );
  }));

it.each(["codex", "opencode"] as const)(
  "the production %s resolver carries the account into program shutdown",
  (provider) =>
    withPool(async (f) => {
      const spawnUrls: string[] = [];
      const stoppedUrls: string[] = [];
      const urlsByPid = new Map<number, string>();
      const spawner = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => {
          const pid = 71000 + spawnUrls.length;
          const url = `http://127.0.0.1:${pid}`;
          spawnUrls.push(url);
          urlsByPid.set(pid, url);
          return Effect.succeed(
            ChildProcessSpawner.makeHandle({
              unref: Effect.succeed(Effect.void),
              pid: ChildProcessSpawner.ProcessId(pid),
              exitCode: Effect.never,
              isRunning: Effect.succeed(true),
              kill: () => Effect.void,
              stdin: Sink.drain,
              stdout: Stream.make(
                new TextEncoder().encode(`opencode server listening on ${url}\n`),
              ),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          );
        }),
      );
      const runtimeLayer = makeOpenCodeRuntimeLive({
        teardownProcessTree: async ({ rootPid }) => {
          const url = urlsByPid.get(rootPid);
          if (url !== undefined) stoppedUrls.push(url);
          return { escalated: false, signalErrors: [] };
        },
      }).pipe(Layer.provide(spawner));
      let sessionId = 0;
      const client = {
        mcp: {
          status: async () => ({ data: {} }),
          add: async () => ({ data: { penkra: { status: "connected" } } }),
        },
        session: {
          create: async () => ({ data: { id: "opencode-native-" + ++sessionId } }),
          abort: async () => ({ data: null }),
          children: async () => ({ data: [] }),
        },
        permission: { list: async () => ({ data: [] }) },
        question: { list: async () => ({ data: [] }) },
        event: {
          subscribe: async (_input: unknown, options: { signal: AbortSignal }) => ({
            stream: {
              [Symbol.asyncIterator]() {
                let waiting: ((value: IteratorResult<never>) => void) | undefined;
                const close = () => {
                  waiting?.({ done: true, value: undefined });
                  waiting = undefined;
                };
                options.signal.addEventListener("abort", close, { once: true });
                return {
                  next: () =>
                    new Promise<IteratorResult<never>>((resolve) => {
                      if (options.signal.aborted) resolve({ done: true, value: undefined });
                      else waiting = resolve;
                    }),
                  return: () => {
                    close();
                    options.signal.removeEventListener("abort", close);
                    return Promise.resolve({ done: true as const, value: undefined });
                  },
                };
              },
            },
          }),
        },
      } as unknown as OpencodeClient;
      const opencodeLayer = Layer.unwrap(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          return makeOpenCodeAdapterLive({
            agentGatewayCredentials: f.credentials,
            loadSharedMcpConfig: async () => "{}",
            runtime: {
              ...runtime,
              createOpenCodeSdkClient: () => client,
              loadOpenCodeProviderList: () =>
                Effect.succeed({ connected: [], all: [], default: {} }),
            },
          });
        }),
      ).pipe(
        Layer.provide(runtimeLayer),
        Layer.provide(
          Layer.succeed(AgentGatewayToolBridge, {
            install: () => undefined,
            requireSurface: () => ({
              definitions: [
                {
                  name: PENKRA_EXEC_COMMAND_NAME,
                  description: PENKRA_EXEC_COMMAND_DESCRIPTION,
                  inputSchema: PENKRA_EXEC_COMMAND_INPUT_SCHEMA,
                },
              ],
              invoke: async () => {
                throw new Error("Native host calls are not executed by this fixture.");
              },
            }),
          }),
        ),
      );
      const registryLayer = Layer.effect(
        ProviderAdapterRegistry,
        Effect.gen(function* () {
          const codex = yield* CodexAdapter;
          const opencode = yield* OpenCodeAdapter;
          return {
            getByProvider: (kind) =>
              kind === "codex" ? Effect.succeed(codex) : Effect.succeed(opencode),
            listProviders: () => Effect.succeed(["codex", "opencode"] as const),
          };
        }),
      ).pipe(
        Layer.provideMerge(makeCodexAdapterLive({ manager: f.manager })),
        Layer.provideMerge(opencodeLayer),
      );
      const installs = Layer.succeed(ProviderInstallationRepository, {
        getActiveRecord: (harness: string) =>
          Effect.succeed(Option.some({ id: ProviderInstallationId.make("install-" + harness) })),
        getRecord: (id: string) =>
          Effect.succeed(
            Option.some({
              id,
              harness: id.endsWith("codex") ? "codex" : "opencode",
              version: "0.157.1",
              platform: "darwin",
              architecture: "arm64",
              executablePath: f.binaryPath,
              artifactSource: "github-release",
              artifactUrl: "https://example.invalid/provider",
              artifactSha256: "a".repeat(64),
              adapterVersion: "1",
              protocolVersion: "v1",
              lifecycle: "active",
              healthReason: null,
              installedAt: at,
              activatedAt: at,
              retiredAt: null,
            }),
          ),
      } as never);
      const connections = Layer.succeed(ProviderConnectionRepository, {
        getRecord: (id: string) =>
          Effect.succeed(
            Option.some({
              id,
              harness: provider,
              authenticationTargetId: provider === "codex" ? "openai-first-party" : "opencode-go",
              authenticationMethodId: provider === "codex" ? "chatgpt" : "api-key",
              label: id,
              credentialRef: provider === "codex" ? null : "provider-secret:" + id,
              profileRef: provider === "codex" ? "provider-profile:" + id : null,
              providerIdentityId: null,
              health: "ready",
              healthReason: null,
              lastCheckedAt: at,
              lifecycle: "active",
              terminationReason: null,
              terminatedAt: null,
              createdAt: at,
              updatedAt: at,
            }),
          ),
      } as never);
      const resolverLayer = ProviderLaunchResolverLive.pipe(
        Layer.provide(installs),
        Layer.provide(connections),
        Layer.provide(
          Layer.succeed(ProviderCredentialBroker, {
            available: true,
            readOnce: () => Effect.succeed("fixture-account-key"),
          } as never),
        ),
      );
      const serviceLayer = makeManagedProviderServiceLive().pipe(
        Layer.provide(ConnectionRateLimitsLive),
        Layer.provide(ProviderAuthCircuitsLive),
        Layer.provideMerge(registryLayer),
        Layer.provide(ProviderSessionDirectoryLive),
        Layer.provide(resolverLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(Layer.succeed(ThreadPublisher, makeThreadPublisher())),
      );
      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO projection_folders (folder_id,space_id,title,workspace_root,default_model_selection_json,created_at,updated_at) VALUES ('owner-folder','penkra-personal','Owner',NULL,NULL,${at},${at})`;
          const service = yield* ProviderService;
          const registry = yield* ProviderAdapterRegistry;
          const ids = [ThreadId.make(provider + "-owner-a"), ThreadId.make(provider + "-owner-b")];
          const accounts = [
            ProviderConnectionId.make("account-a"),
            ProviderConnectionId.make("account-b"),
          ];
          for (let index = 0; index < ids.length; index++) {
            const threadId = ids[index]!;
            const account = accounts[index]!;
            const modelSelection =
              provider === "codex"
                ? { provider, model: "gpt-5.5" }
                : { provider, model: "opencode-go/deepseek-v4.1-flash" };
            yield* createThreadFixture(sql, {
              threadId,
              folderId: FolderId.make("owner-folder"),
              title: "Owner",
              modelSelection,
              runtimeMode: "full-access",
              connection: { kind: "selected", connectionId: account },
              creator: { kind: "user" },
              createdAt: at,
            });
            yield* sql`UPDATE threads SET native_state_id=${"native-" + threadId} WHERE id=${threadId}`;
            // No managedLaunch is supplied: this is the production resolver callback.
            yield* service.ensure(threadId, {
              provider,
              threadId,
              runtimeMode: "full-access",
              modelSelection,
              cwd: f.root,
            });
          }
          const adapter = yield* registry.getByProvider(provider);
          if (!adapter.stopAccount) throw new Error("Expected account shutdown");
          yield* adapter.stopAccount(accounts[0]!);
          expect(yield* adapter.hasSession(ids[0]!)).toBe(false);
          expect(yield* adapter.hasSession(ids[1]!)).toBe(true);
          if (provider === "codex") {
            const calls = yield* Effect.promise(() => f.events());
            expect(calls.filter((event) => event.event === "spawn")).toHaveLength(2);
            yield* Effect.tryPromise(() =>
              f.manager.sendTurn({ threadId: ids[1]!, input: "Other account still works" }),
            );
            yield* Effect.tryPromise(() => f.command(ids[1]!, "test/autoClose", {}));
          } else {
            expect(spawnUrls).toHaveLength(2);
            expect(stoppedUrls).toEqual([spawnUrls[0]]);
          }
          yield* service.closeRuntimeEvents;
          expect(yield* adapter.hasSession(ids[1]!)).toBe(false);
          if (provider === "opencode") expect(stoppedUrls).toEqual(spawnUrls);
        }).pipe(
          Effect.provide(serviceLayer),
          Effect.provideService(ServerConfig, {
            stateDir: f.root,
            baseDir: f.root,
            cwd: f.root,
            homeDir: f.root,
          } as typeof ServerConfig.Service),
          Effect.provide(NodeServices.layer),
          Effect.provide(SqlitePersistenceMemory),
          Effect.scoped,
        ),
      );
    }),
);

it("reads usage on the exact shared account process without opening a conversation", () =>
  withPool(async (f) => {
    const a = await f.launch("account-a"),
      b = await f.launch("account-b");
    const result = await Promise.all(
      [a, b].map((managedLaunch) => f.manager.readUsage({ cwd: f.root, managedLaunch })),
    );
    expect(result.map((value) => [value.connectionId, value.limits[0]?.usedPercent])).toEqual([
      ["account-a", 12],
      ["account-b", 67],
    ]);
    expect(f.manager.listSessions()).toEqual([]);
    await f.manager.loadCatalog({ cwd: f.root, managedLaunch: a, kinds: ["models"] });
    expect((await f.events()).filter((event) => event.event === "spawn")).toHaveLength(2);
  }));

it("keeps a rejected native usage read local and recognizes a native signed-out account", () =>
  withPool(async (f) => {
    const managedLaunch = await f.launch("usage-error");
    await expect(f.manager.readUsage({ cwd: f.root, managedLaunch })).rejects.toThrow(
      "Usage rejected",
    );
    await f.manager.loadCatalog({ cwd: f.root, managedLaunch, kinds: ["models"] });
    expect((await f.events()).filter((event) => event.event === "spawn")).toHaveLength(1);
    const signedOut = await f.manager.readUsage({
      cwd: f.root,
      managedLaunch: await f.launch("signed-out"),
    });
    expect(signedOut.status).toBe("needs-auth");
    expect((await f.events()).filter((event) => event.event === "usage")).toHaveLength(1);
  }));
