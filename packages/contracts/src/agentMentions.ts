/**
 * Agent Mentions - @alias(task) syntax for subagent delegation.
 *
 * Provides provider-aware alias metadata used by the composer UI and provider runtimes.
 */

import type { ProviderKind } from "./orchestration";
import type { ModelSlug } from "./model";

type AgentAliasColor = "violet" | "fuchsia" | "teal" | "cyan" | "amber" | "orange";

interface BaseAgentAliasDefinition {
  readonly provider: ProviderKind;
  readonly displayName: string;
  readonly color: AgentAliasColor;
}

export interface CodexAgentAliasDefinition extends BaseAgentAliasDefinition {
  readonly provider: "codex";
  readonly kind: "model";
  readonly model: ModelSlug;
}

export interface ClaudeSubagentAliasDefinition extends BaseAgentAliasDefinition {
  readonly provider: "claudeAgent";
  readonly kind: "claude-subagent";
  readonly agentName: string;
  readonly description: string;
  readonly prompt: string;
  readonly tools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly model?: string;
}

export type AgentAliasDefinition = CodexAgentAliasDefinition | ClaudeSubagentAliasDefinition;

export type ResolvedAgentAlias = AgentAliasDefinition & {
  readonly alias: string;
};

const OPENCODE_AGENT_MENTION_ALIASES: Record<string, AgentAliasDefinition> = {};
const CODEX_AGENT_MENTION_ALIASES: Record<string, CodexAgentAliasDefinition> = {};
const CLAUDE_AGENT_MENTION_ALIASES: Record<string, ClaudeSubagentAliasDefinition> = {};

export const AGENT_MENTION_ALIASES_BY_PROVIDER: Record<
  ProviderKind,
  Record<string, AgentAliasDefinition>
> = {
  codex: CODEX_AGENT_MENTION_ALIASES,
  claudeAgent: CLAUDE_AGENT_MENTION_ALIASES,
  opencode: OPENCODE_AGENT_MENTION_ALIASES,
} as const satisfies Record<ProviderKind, Record<string, AgentAliasDefinition>>;

// Backward compatibility for legacy call sites that still expect a flat alias table.
export const AGENT_MENTION_ALIASES: Record<string, AgentAliasDefinition> = Object.assign(
  {},
  ...Object.values(AGENT_MENTION_ALIASES_BY_PROVIDER),
);

const AGENT_MENTION_AUTOCOMPLETE_ALIASES_BY_PROVIDER: Record<ProviderKind, readonly string[]> = {
  codex: [],
  claudeAgent: [],
  opencode: [],
};

function mapAgentEntries(input: Record<string, AgentAliasDefinition>): ResolvedAgentAlias[] {
  return Object.entries(input)
    .map(([alias, definition]) => Object.assign({ alias }, definition))
    .toSorted((a, b) => a.alias.localeCompare(b.alias));
}

/**
 * Get all available agent aliases for a provider. When no provider is passed,
 * returns the global union for parsing and validation helpers.
 */
export function getAgentMentionAliases(provider?: ProviderKind): ResolvedAgentAlias[] {
  if (provider) {
    return mapAgentEntries(AGENT_MENTION_ALIASES_BY_PROVIDER[provider]);
  }

  return Object.values(AGENT_MENTION_ALIASES_BY_PROVIDER).flatMap((definitions) =>
    mapAgentEntries(definitions),
  );
}

/**
 * Get the preferred aliases shown in autocomplete for a provider.
 */
export function getAgentMentionAutocompleteAliases(provider: ProviderKind): ResolvedAgentAlias[] {
  return AGENT_MENTION_AUTOCOMPLETE_ALIASES_BY_PROVIDER[provider].map((alias) => {
    const definition = AGENT_MENTION_ALIASES_BY_PROVIDER[provider][alias];
    if (!definition) {
      throw new Error(`Unknown autocomplete alias for ${provider}: ${alias}`);
    }

    return Object.assign({ alias }, definition);
  });
}

/**
 * Resolve an agent alias. When a provider is passed, only provider-specific aliases are considered.
 */
export function resolveAgentAlias(
  alias: string,
  provider?: ProviderKind,
): AgentAliasDefinition | null {
  const normalized = alias.toLowerCase();
  if (provider) {
    return AGENT_MENTION_ALIASES_BY_PROVIDER[provider][normalized] ?? null;
  }

  for (const definitions of Object.values(AGENT_MENTION_ALIASES_BY_PROVIDER)) {
    const resolved = definitions[normalized];
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

export function isValidAgentAlias(alias: string, provider?: ProviderKind): boolean {
  return resolveAgentAlias(alias, provider) !== null;
}

export function getAgentAliasNames(provider?: ProviderKind): string[] {
  if (provider) {
    return Object.keys(AGENT_MENTION_ALIASES_BY_PROVIDER[provider]);
  }

  return Object.values(AGENT_MENTION_ALIASES_BY_PROVIDER).flatMap((definitions) =>
    Object.keys(definitions),
  );
}
