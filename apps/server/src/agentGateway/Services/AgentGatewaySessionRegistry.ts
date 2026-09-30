import type { ProviderKind, ThreadId } from "@penkra/contracts";
import { ServiceMap } from "effect";

export type AgentGatewayCapability = "thread:read" | "thread:write" | "diagnostics:read";

export interface AgentGatewaySessionIdentity {
  readonly sessionKey: string;
  readonly threadId: ThreadId;
  readonly provider: ProviderKind;
  readonly issuedAt: number;
  readonly lifecycleGeneration?: string;
  readonly activeTurnId: string | null;
  readonly capabilities: ReadonlySet<AgentGatewayCapability>;
}

export interface AgentGatewayIssuedSession extends AgentGatewaySessionIdentity {
  readonly token: string;
}

export interface AgentGatewayWriteAuthority {
  readonly sessionKey: string;
  readonly threadId: ThreadId;
  readonly provider: ProviderKind;
  readonly turnId: string;
}

export interface AgentGatewaySessionRegistryShape {
  readonly issue: (
    threadId: ThreadId,
    provider: ProviderKind,
    lifecycleGeneration?: string,
  ) => AgentGatewayIssuedSession;
  readonly verify: (token: string) => AgentGatewaySessionIdentity | null;
  readonly beginTurn: (
    threadId: ThreadId,
    provider: ProviderKind,
    turnId: string,
    lifecycleGeneration?: string,
  ) => void;
  readonly endTurn: (
    threadId: ThreadId,
    provider: ProviderKind,
    turnId: string,
    lifecycleGeneration?: string,
  ) => void;
  readonly endSession: (
    threadId: ThreadId,
    provider: ProviderKind,
    lifecycleGeneration?: string,
  ) => void;
  readonly bindWriteAuthority: (token: string) => AgentGatewayWriteAuthority | null;
  readonly verifyWriteAuthority: (authority: AgentGatewayWriteAuthority) => boolean;
  readonly revoke: (token: string) => void;
}

export class AgentGatewaySessionRegistry extends ServiceMap.Service<
  AgentGatewaySessionRegistry,
  AgentGatewaySessionRegistryShape
>()("penkra/agentGateway/Services/AgentGatewaySessionRegistry") {}
