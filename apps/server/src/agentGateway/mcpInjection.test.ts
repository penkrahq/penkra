import { assert, describe, it } from "@effect/vitest";

import {
  buildAcpPenkraMcpServers,
  buildOpenCodeMcpServer,
  callAgentGatewayMcpTool,
  listAgentGatewayMcpTools,
  PENKRA_AGENT_GATEWAY_TOKEN_ENV,
} from "./mcpInjection.ts";

const connection = {
  url: "http://127.0.0.1:3773/mcp",
  bearerToken: "sagw_abc.def",
};

const stdioProxy = {
  command: "/usr/local/bin/node",
  args: ["/state/agent-gateway-mcp-proxy.mjs"],
};

describe("agent gateway MCP injection", () => {
  it("builds an authenticated OpenCode remote MCP config with OAuth disabled", () => {
    assert.deepEqual(buildOpenCodeMcpServer(connection), {
      type: "remote",
      url: connection.url,
      enabled: true,
      headers: { Authorization: `Bearer ${connection.bearerToken}` },
      oauth: false,
    });
  });

  it("loads and invokes the canonical gateway catalog for native-tool providers", async () => {
    const requests: Array<{ readonly authorization: string | null; readonly body: unknown }> = [];
    const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      const body: unknown = JSON.parse(String(init?.body));
      requests.push({
        authorization: new Headers(init?.headers).get("Authorization"),
        body,
      });
      const request = body as { readonly id: string; readonly method: string };
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result:
          request.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "penkra_exec_command",
                    description: "Execute one registered Penkra command.",
                    inputSchema: {
                      type: "object",
                      properties: { command: { type: "string" } },
                      required: ["command"],
                    },
                  },
                ],
              }
            : { content: [{ type: "text", text: "ok" }] },
      });
    };

    assert.deepEqual(await listAgentGatewayMcpTools({ connection, fetch }), [
      {
        name: "penkra_exec_command",
        description: "Execute one registered Penkra command.",
        inputSchema: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
    ]);
    assert.deepEqual(
      await callAgentGatewayMcpTool({
        connection,
        name: "penkra_exec_command",
        arguments: { command: "penkra threads list --limit 2" },
        fetch,
      }),
      { content: [{ type: "text", text: "ok" }] },
    );
    assert.deepEqual(
      requests.map((request) => request.authorization),
      [`Bearer ${connection.bearerToken}`, `Bearer ${connection.bearerToken}`],
    );
    assert.deepEqual((requests[1]?.body as { readonly params: unknown }).params, {
      name: "penkra_exec_command",
      arguments: { command: "penkra threads list --limit 2" },
    });
  });

  it("uses the ACP http transport when the agent advertises support", () => {
    const servers = buildAcpPenkraMcpServers({
      connection,
      initializeResult: { agentCapabilities: { mcpCapabilities: { http: true } } },
      stdioProxy,
    });
    assert.deepEqual(servers, [
      {
        type: "http",
        name: "penkra",
        url: connection.url,
        headers: [{ name: "Authorization", value: `Bearer ${connection.bearerToken}` }],
      },
    ]);
  });

  it("falls back to the stdio proxy when http is not advertised", () => {
    const servers = buildAcpPenkraMcpServers({
      connection,
      initializeResult: {},
      stdioProxy,
    });
    assert.deepEqual(servers, [
      {
        name: "penkra",
        command: stdioProxy.command,
        args: stdioProxy.args,
        env: [
          { name: "PENKRA_AGENT_GATEWAY_URL", value: connection.url },
          { name: PENKRA_AGENT_GATEWAY_TOKEN_ENV, value: connection.bearerToken },
        ],
      },
    ]);
  });
});
