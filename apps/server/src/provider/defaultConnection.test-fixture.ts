import {
  ProviderConnectionId,
  type ProviderConnection,
  type ProviderKind,
} from "@penkra/contracts";

export function connectionFixture(provider: ProviderKind, id: string): ProviderConnection {
  return {
    id: ProviderConnectionId.makeUnsafe(id),
    harness: provider,
    authenticationTargetId:
      provider === "opencode"
        ? "opencode-go"
        : provider === "codex"
          ? "openai-first-party"
          : "anthropic-first-party",
    authenticationMethodId:
      provider === "opencode" ? "api-key" : provider === "codex" ? "chatgpt" : "claude",
    label: id,
    providerIdentityId: null,
    health: "ready",
    healthReason: null,
    lastCheckedAt: null,
    lifecycle: "active",
    terminationReason: null,
    terminatedAt: null,
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
  };
}
