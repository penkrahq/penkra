// FILE: AgentGatewayToolBridge.ts
// Purpose: One shared, replaceable-at-restart host-tool bridge instance.

import { Layer } from "effect";

import {
  AgentGatewayToolBridge,
  type AgentGatewayNativeToolSurface,
  type AgentGatewayToolBridgeShape,
} from "../Services/AgentGatewayToolBridge.ts";

export function makeAgentGatewayToolBridge(): AgentGatewayToolBridgeShape {
  let surface: AgentGatewayNativeToolSurface | null = null;
  return {
    install: (next) => {
      surface = next;
    },
    requireSurface: () => {
      if (surface === null) {
        throw new Error("Penkra's host tool is not ready.");
      }
      return surface;
    },
  };
}

export const AgentGatewayToolBridgeLive = Layer.succeed(
  AgentGatewayToolBridge,
  makeAgentGatewayToolBridge(),
);
