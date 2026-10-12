// FILE: codexThreadMcp.test.ts
// Purpose: Check the actual manager's start/resume authentication boundary.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as Path from "node:path";
import { ThreadId } from "@penkra/contracts";
import { expect, it } from "vitest";
import { CodexAppServerManager } from "./codexAppServerManager";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

it("sends fresh thread lease headers on start and resume without a process credential", async () => {
  const root = await mkdtemp(Path.join(tmpdir(), "penkra-codex-thread-mcp-"));
  const script = Path.join(root, "app-server.cjs");
  const logPath = Path.join(root, "requests.jsonl");
  const binaryPath = Path.join(root, process.platform === "win32" ? "codex.cmd" : "codex");
  await writeFile(
    script,
    `
const fs = require('node:fs');
const readline = require('node:readline');
const logPath = ${JSON.stringify(logPath)};
readline.createInterface({input:process.stdin}).on('line',line => {
  const request=JSON.parse(line);
  fs.appendFileSync(logPath,JSON.stringify({method:request.method,params:request.params,processToken:process.env.PENKRA_AGENT_GATEWAY_TOKEN})+'\\n');
  if(request.id===undefined)return;
  let result={};
  if(request.method==='thread/start')result={thread:{id:'native-thread',status:'idle'}};
  if(request.method==='thread/resume')result={thread:{id:request.params.threadId,status:'idle'}};
  if(request.method==='model/list')result={data:[]};
  if(request.method==='mcpServerStatus/list')result={data:[],nextCursor:null};
  if(request.method==='plugin/list')result={marketplaces:[]};
  process.stdout.write(JSON.stringify({id:request.id,result})+'\\n');
});
`,
  );
  await writeFile(
    binaryPath,
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
      : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`,
    { mode: 0o755 },
  );
  const profileRoot = Path.join(root, "profile");
  await mkdir(profileRoot);
  let lease = 0;
  const released: number[] = [];
  const manager = new CodexAppServerManager(undefined, {
    stateDir: root,
    agentGatewayHostTool: {
      acquireSessionLease: () => {
        const current = ++lease;
        return {
          connection: { url: "http://gateway.test/mcp", bearerToken: `thread-lease-${current}` },
          release: () => {
            released.push(current);
          },
        };
      },
      requireNativeSurface: () => ({ definitions: [], invoke: async () => ({ content: [] }) }),
    },
  });
  const input = {
    threadId: ThreadId.makeUnsafe("mcp-thread"),
    provider: "codex" as const,
    cwd: root,
    model: "gpt-5.5",
    runtimeMode: "full-access" as const,
    managedLaunch: {
      binaryPath,
      profileRoot,
      nativeStateRoot: Path.join(root, "native"),
      isolationKey: "account",
      childEnvironment: (env: NodeJS.ProcessEnv) => ({
        ...env,
        PENKRA_AGENT_GATEWAY_TOKEN: "stale-process-token",
      }),
    },
  };
  try {
    const started = await manager.startSession(input);
    await manager.stopSession(input.threadId);
    await manager.startSession({ ...input, resumeCursor: started.resumeCursor });
    await manager.stopSession(input.threadId);
    const requests = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(requests.every((request) => request.processToken === undefined)).toBe(true);
    expect(requests.find((request) => request.method === "thread/start").params.config).toEqual({
      "mcp_servers.penkra": {
        url: "http://gateway.test/mcp",
        http_headers: { Authorization: "Bearer thread-lease-1" },
      },
    });
    expect(requests.find((request) => request.method === "thread/resume").params.config).toEqual({
      "mcp_servers.penkra": {
        url: "http://gateway.test/mcp",
        http_headers: { Authorization: "Bearer thread-lease-2" },
      },
    });
    expect(released).toEqual([1, 2]);
  } finally {
    await manager.stopAll();
    await rm(root, { recursive: true, force: true });
  }
});
