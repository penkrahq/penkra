/**
 * Provider-facing configuration for the authenticated Penkra MCP gateway.
 *
 * Codex and Claude receive the gateway through their managed stdio MCP proxy.
 * OpenCode needs the equivalent remote-server shape for its dynamic MCP
 * configuration endpoint, which is the provider-specific mapping below.
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
