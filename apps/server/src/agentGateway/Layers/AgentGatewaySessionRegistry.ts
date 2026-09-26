import { randomUUID } from "node:crypto";

import { Layer } from "effect";

import {
  AgentGatewaySessionRegistry,
  type AgentGatewaySessionIdentity,
  type AgentGatewaySessionRegistryShape,
} from "../Services/AgentGatewaySessionRegistry.ts";

export function makeAgentGatewaySessionRegistry(options?: {
  readonly now?: () => number;
  readonly randomId?: () => string;
}): AgentGatewaySessionRegistryShape {
  const now = options?.now ?? Date.now;
  const randomId = options?.randomId ?? randomUUID;
  const sessions = new Map<string, AgentGatewaySessionIdentity>();

  return {
    issue: (threadId, provider) => {
      // Every provider runtime owns an independent credential. Replacement
      // runtimes overlap their predecessor during startup, and the outgoing
      // runtime revokes its own token during teardown. Reusing a token here
      // would therefore let old-session cleanup invalidate the replacement.
      const issuedAt = now();
      const sessionKey = `gateway-session:${randomId()}`;
      const token = `sagw_session_${randomId()}`;
      const identity: AgentGatewaySessionIdentity = {
        sessionKey,
        threadId,
        provider,
        issuedAt,
        capabilities: new Set(["thread:read", "thread:write", "diagnostics:read"]),
      };
      sessions.set(token, identity);
      return { token, ...identity };
    },
    verify: (token) => {
      const identity = sessions.get(token);
      if (!identity) return null;
      return identity;
    },
    revoke: (token) => {
      const identity = sessions.get(token);
      if (!identity) return;
      sessions.delete(token);
    },
  };
}

export const AgentGatewaySessionRegistryLive = Layer.sync(
  AgentGatewaySessionRegistry,
  makeAgentGatewaySessionRegistry,
);
