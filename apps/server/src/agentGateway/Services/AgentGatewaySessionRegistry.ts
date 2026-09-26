import type { ProviderKind, ThreadId } from "@penkra/contracts";
import { ServiceMap } from "effect";

export type AgentGatewayCapability = "thread:read" | "thread:write" | "diagnostics:read";

export interface AgentGatewaySessionIdentity {
  readonly sessionKey: string;
  readonly threadId: ThreadId;
  readonly provider: ProviderKind;
  readonly issuedAt: number;
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
  readonly issue: (threadId: ThreadId, provider: ProviderKind) => AgentGatewayIssuedSession;
  readonly verify: (token: string) => AgentGatewaySessionIdentity | null;
  readonly bindWriteAuthority: (token: string, turnId: string) => AgentGatewayWriteAuthority | null;
  readonly verifyWriteAuthority: (authority: AgentGatewayWriteAuthority) => boolean;
  readonly revoke: (token: string) => void;
}

export class AgentGatewaySessionRegistry extends ServiceMap.Service<
  AgentGatewaySessionRegistry,
  AgentGatewaySessionRegistryShape
>()("penkra/agentGateway/Services/AgentGatewaySessionRegistry") {}
