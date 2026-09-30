import { randomUUID } from "node:crypto";

import { Layer } from "effect";

import {
  AgentGatewaySessionRegistry,
  type AgentGatewaySessionIdentity,
  type AgentGatewayWriteAuthority,
  type AgentGatewaySessionRegistryShape,
} from "../Services/AgentGatewaySessionRegistry.ts";

export function makeAgentGatewaySessionRegistry(options?: {
  readonly now?: () => number;
  readonly randomId?: () => string;
}): AgentGatewaySessionRegistryShape {
  const now = options?.now ?? Date.now;
  const randomId = options?.randomId ?? randomUUID;
  const sessions = new Map<string, AgentGatewaySessionIdentity>();
  const sessionsByKey = new Map<string, AgentGatewaySessionIdentity>();

  return {
    issue: (threadId, provider, lifecycleGeneration) => {
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
        ...(lifecycleGeneration === undefined ? {} : { lifecycleGeneration }),
        activeTurnId: null,
        capabilities: new Set(["thread:read", "thread:write", "diagnostics:read"]),
      };
      sessions.set(token, identity);
      sessionsByKey.set(sessionKey, identity);
      return { token, ...identity };
    },
    verify: (token) => {
      const identity = sessions.get(token);
      if (!identity) return null;
      return identity;
    },
    beginTurn: (threadId, provider, turnId, lifecycleGeneration) => {
      const owner = [...sessions.values()]
        .reverse()
        .find(
          (identity) =>
            identity.threadId === threadId &&
            identity.provider === provider &&
            identity.lifecycleGeneration === lifecycleGeneration,
        );
      if (owner) {
        // A replacement can overlap its predecessor. Once its turn starts,
        // outgoing credentials must not retain authority over the thread.
        for (const [token, identity] of sessions) {
          if (
            identity.threadId === threadId &&
            identity.provider === provider &&
            identity.sessionKey !== owner.sessionKey &&
            identity.activeTurnId !== null
          ) {
            const cleared = { ...identity, activeTurnId: null };
            sessions.set(token, cleared);
            sessionsByKey.set(identity.sessionKey, cleared);
          }
        }
        const updated = { ...owner, activeTurnId: turnId };
        for (const [token, identity] of sessions) {
          if (identity.sessionKey === owner.sessionKey) sessions.set(token, updated);
        }
        sessionsByKey.set(owner.sessionKey, updated);
      }
    },
    endTurn: (threadId, provider, turnId, lifecycleGeneration) => {
      const owner = [...sessions.values()]
        .reverse()
        .find(
          (identity) =>
            identity.threadId === threadId &&
            identity.provider === provider &&
            identity.lifecycleGeneration === lifecycleGeneration,
        );
      if (owner?.activeTurnId === turnId) {
        const updated = { ...owner, activeTurnId: null };
        for (const [token, identity] of sessions) {
          if (identity.sessionKey === owner.sessionKey) sessions.set(token, updated);
        }
        sessionsByKey.set(owner.sessionKey, updated);
      }
    },
    endSession: (threadId, provider, lifecycleGeneration) => {
      const owner = [...sessions.values()]
        .reverse()
        .find(
          (identity) =>
            identity.threadId === threadId &&
            identity.provider === provider &&
            identity.lifecycleGeneration === lifecycleGeneration,
        );
      if (owner) {
        const updated = { ...owner, activeTurnId: null };
        for (const [token, identity] of sessions) {
          if (identity.sessionKey === owner.sessionKey) sessions.set(token, updated);
        }
        sessionsByKey.set(owner.sessionKey, updated);
      }
    },
    bindWriteAuthority: (token) => {
      const identity = sessions.get(token);
      if (!identity?.activeTurnId) return null;
      return {
        sessionKey: identity.sessionKey,
        threadId: identity.threadId,
        provider: identity.provider,
        turnId: identity.activeTurnId,
      } satisfies AgentGatewayWriteAuthority;
    },
    verifyWriteAuthority: (authority) => {
      const identity = sessionsByKey.get(authority.sessionKey);
      return (
        identity !== undefined &&
        identity.threadId === authority.threadId &&
        identity.provider === authority.provider &&
        identity.activeTurnId === authority.turnId
      );
    },
    revoke: (token) => {
      const identity = sessions.get(token);
      if (!identity) return;
      sessions.delete(token);
      sessionsByKey.delete(identity.sessionKey);
    },
  };
}

export const AgentGatewaySessionRegistryLive = Layer.sync(
  AgentGatewaySessionRegistry,
  makeAgentGatewaySessionRegistry,
);
