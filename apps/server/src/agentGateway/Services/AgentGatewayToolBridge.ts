// FILE: AgentGatewayToolBridge.ts
// Purpose: Provider-neutral in-process boundary for Penkra's host tool.

import type { McpToolCallResult, McpToolDefinition } from "../protocol.ts";
import { ServiceMap } from "effect";

export interface AgentGatewayNativeToolSurface {
  readonly definitions: ReadonlyArray<McpToolDefinition>;
  readonly invoke: (input: {
    readonly bearerToken: string;
    readonly name: string;
    readonly arguments: Record<string, unknown>;
  }) => Promise<McpToolCallResult>;
}

export interface AgentGatewayToolBridgeShape {
  /** Install the canonical dispatcher once the server graph has constructed it. */
  readonly install: (surface: AgentGatewayNativeToolSurface) => void;
  /** Read the exact native surface or fail closed while the server is unavailable. */
  readonly requireSurface: () => AgentGatewayNativeToolSurface;
}

export class AgentGatewayToolBridge extends ServiceMap.Service<
  AgentGatewayToolBridge,
  AgentGatewayToolBridgeShape
>()("penkra/agentGateway/Services/AgentGatewayToolBridge") {}
