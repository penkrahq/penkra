/**
 * Provider-facing config builders for the Penkra agent gateway.
 *
 * One shared module shapes the same MCP connection (endpoint URL + per-thread
 * bearer token) into every provider's native MCP configuration format so the
 * injection rules cannot drift between adapters:
 *
 * Codex and Claude use their native tool APIs. OpenCode receives the shared
 * gateway through its dynamic MCP configuration endpoint.
 *
 * @module agentGateway/mcpInjection
 */
import type { AgentGatewayMcpConnection } from "./Services/AgentGatewayCredentials";

export const PENKRA_MCP_SERVER_NAME = "penkra";
export const PENKRA_AGENT_GATEWAY_TOKEN_ENV = "PENKRA_AGENT_GATEWAY_TOKEN";

export interface OpenCodeMcpRemoteServerConfig {
  readonly type: "remote";
  readonly url: string;
  readonly enabled: true;
  readonly headers: Record<string, string>;
  readonly oauth: false;
}

/**
 * OpenCode's dynamic `mcp.add` endpoint is process/directory scoped rather
 * than session scoped. Callers must only install this config into a provider
 * server that is proven to be dedicated to the owning Penkra thread.
 */
export function buildOpenCodeMcpServer(
  connection: AgentGatewayMcpConnection,
): OpenCodeMcpRemoteServerConfig {
  return {
    type: "remote",
    url: connection.url,
    enabled: true,
    headers: { Authorization: `Bearer ${connection.bearerToken}` },
    oauth: false,
  };
}

export interface AgentGatewayMcpToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export type AgentGatewayMcpFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface JsonRpcSuccess {
  readonly jsonrpc: "2.0";
  readonly id: string;
  readonly result: unknown;
}

interface JsonRpcFailure {
  readonly jsonrpc: "2.0";
  readonly id: string | null;
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function postAgentGatewayJsonRpc(input: {
  readonly connection: AgentGatewayMcpConnection;
  readonly method: string;
  readonly params?: Record<string, unknown>;
  readonly signal?: AbortSignal;
  readonly fetch?: AgentGatewayMcpFetch;
}): Promise<unknown> {
  const id = globalThis.crypto.randomUUID();
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const response = await fetchImpl(input.connection.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.connection.bearerToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: input.method,
      ...(input.params === undefined ? {} : { params: input.params }),
    }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (!response.ok) {
    throw new Error(`Penkra MCP request failed with HTTP ${String(response.status)}.`);
  }
  const payload: unknown = await response.json();
  if (!isRecord(payload) || payload.jsonrpc !== "2.0") {
    throw new Error("Penkra MCP returned an invalid JSON-RPC response.");
  }
  if ("error" in payload) {
    const failure = payload as unknown as JsonRpcFailure;
    throw new Error(failure.error?.message || "Penkra MCP request failed.");
  }
  const success = payload as unknown as JsonRpcSuccess;
  if (success.id !== id || !("result" in success)) {
    throw new Error("Penkra MCP returned a mismatched JSON-RPC response.");
  }
  return success.result;
}

/** Load the canonical gateway tool descriptors for native-tool providers. */
export async function listAgentGatewayMcpTools(input: {
  readonly connection: AgentGatewayMcpConnection;
  readonly fetch?: AgentGatewayMcpFetch;
  readonly signal?: AbortSignal;
}): Promise<ReadonlyArray<AgentGatewayMcpToolDescriptor>> {
  const result = await postAgentGatewayJsonRpc({
    ...input,
    method: "tools/list",
  });
  if (!isRecord(result) || !Array.isArray(result.tools)) {
    throw new Error("Penkra MCP tools/list returned an invalid tool catalog.");
  }
  return result.tools.map((value) => {
    if (
      !isRecord(value) ||
      typeof value.name !== "string" ||
      typeof value.description !== "string" ||
      !isRecord(value.inputSchema)
    ) {
      throw new Error("Penkra MCP tools/list returned an invalid tool descriptor.");
    }
    return {
      name: value.name,
      description: value.description,
      inputSchema: value.inputSchema,
    };
  });
}

/** Invoke the canonical gateway dispatcher through its authenticated MCP route. */
export function callAgentGatewayMcpTool(input: {
  readonly connection: AgentGatewayMcpConnection;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly fetch?: AgentGatewayMcpFetch;
  readonly signal?: AbortSignal;
}): Promise<unknown> {
  return postAgentGatewayJsonRpc({
    connection: input.connection,
    method: "tools/call",
    params: { name: input.name, arguments: input.arguments },
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}
