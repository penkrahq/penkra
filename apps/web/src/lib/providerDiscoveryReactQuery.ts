import {
  ProviderListModelsResult,
  type ProviderComposerCapabilities,
  type ProviderKind,
  type ProviderListAgentsResult,
  type ProviderListCommandsResult,
  type ProviderListModelsResult as ProviderListModelsResultType,
  type ProviderListPluginsResult,
  type ProviderListSkillsResult,
  type ProviderSkillsCatalogResult,
} from "@penkra/contracts";
import { Schema } from "effect";
import { queryOptions } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";

const EMPTY_SKILLS_RESULT: ProviderListSkillsResult = {
  skills: [],
  source: "empty",
  cached: false,
};

const EMPTY_COMMANDS_RESULT: ProviderListCommandsResult = {
  commands: [],
  source: "empty",
  cached: false,
};

const EMPTY_MODELS_RESULT: ProviderListModelsResultType = {
  models: [],
  source: "empty",
  cached: false,
};

const EMPTY_AGENTS_RESULT: ProviderListAgentsResult = {
  agents: [],
  source: "empty",
  cached: false,
};

const EMPTY_PLUGINS_RESULT: ProviderListPluginsResult = {
  marketplaces: [],
  marketplaceLoadErrors: [],
  remoteSyncError: null,
  featuredPluginIds: [],
  source: "empty",
  cached: false,
};

const OPENCODE_MODEL_CACHE_KEY_PREFIX = "penkra:opencode-model-catalog:v1:";
const OPENCODE_MODEL_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const decodeProviderListModelsResult = Schema.decodeUnknownSync(ProviderListModelsResult);

function openCodeModelCacheKey(input: {
  binaryPath?: string | null;
  apiEndpoint?: string | null;
  agentDir?: string | null;
  cwd?: string | null;
}): string {
  return `${OPENCODE_MODEL_CACHE_KEY_PREFIX}${JSON.stringify([
    input.binaryPath ?? null,
    input.apiEndpoint ?? null,
    input.agentDir ?? null,
    input.cwd ?? null,
  ])}`;
}

function readOpenCodeModelCache(input: {
  binaryPath?: string | null;
  apiEndpoint?: string | null;
  agentDir?: string | null;
  cwd?: string | null;
}): ProviderListModelsResultType | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(openCodeModelCacheKey(input));
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || !("storedAt" in parsed)) {
      return undefined;
    }
    const storedAt = (parsed as { storedAt?: unknown }).storedAt;
    if (
      typeof storedAt !== "number" ||
      !Number.isFinite(storedAt) ||
      Date.now() - storedAt > OPENCODE_MODEL_CACHE_MAX_AGE_MS ||
      !("result" in parsed)
    ) {
      return undefined;
    }
    const result = decodeProviderListModelsResult((parsed as { result: unknown }).result);
    return result.models.length > 0 ? { ...result, cached: true } : undefined;
  } catch {
    return undefined;
  }
}

function writeOpenCodeModelCache(
  input: {
    binaryPath?: string | null;
    apiEndpoint?: string | null;
    agentDir?: string | null;
    cwd?: string | null;
  },
  result: ProviderListModelsResultType,
): void {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return;
    const key = openCodeModelCacheKey(input);
    if (result.models.length === 0) {
      storage.removeItem(key);
      return;
    }
    storage.setItem(key, JSON.stringify({ storedAt: Date.now(), result }));
  } catch {
    // Discovery remains authoritative. A blocked or full localStorage must not
    // turn a successful model refresh into a user-visible failure.
  }
}

export const providerDiscoveryQueryKeys = {
  all: ["provider-discovery"] as const,
  composerCapabilities: (provider: ProviderKind) =>
    ["provider-discovery", "composer-capabilities", provider] as const,
  commands: (
    provider: ProviderKind,
    cwd: string | null,
    agentDir: string | null,
    connectionKey: string | null,
  ) => ["provider-discovery", "commands", provider, cwd, agentDir, connectionKey] as const,
  // The skill list is query-independent (filtering is client-side), so the key
  // deliberately excludes the typed filter to avoid a refetch per keystroke.
  skills: (provider: ProviderKind, cwd: string | null, agentDir: string | null) =>
    ["provider-discovery", "skills", provider, cwd, agentDir] as const,
  skillsCatalog: (cwd: string | null) => ["provider-discovery", "skills-catalog", cwd] as const,
  plugins: (provider: ProviderKind, cwd: string | null, threadId: string | null) =>
    ["provider-discovery", "plugins", provider, cwd, threadId] as const,
  plugin: (
    provider: ProviderKind,
    marketplacePath: string,
    pluginName: string,
    cwd: string | null,
    threadId: string | null,
  ) =>
    ["provider-discovery", "plugin", provider, marketplacePath, pluginName, cwd, threadId] as const,
  models: (
    provider: ProviderKind,
    binaryPath: string | null,
    apiEndpoint: string | null,
    agentDir: string | null,
    cwd: string | null,
  ) => ["provider-discovery", "models", provider, binaryPath, apiEndpoint, agentDir, cwd] as const,
  agentsForProvider: (provider: ProviderKind) =>
    ["provider-discovery", "agents", provider] as const,
  agents: (provider: ProviderKind, binaryPath: string | null, cwd: string | null) =>
    [...providerDiscoveryQueryKeys.agentsForProvider(provider), binaryPath, cwd] as const,
};

export function providerComposerCapabilitiesQueryOptions(provider: ProviderKind) {
  return queryOptions({
    queryKey: providerDiscoveryQueryKeys.composerCapabilities(provider),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.provider.getComposerCapabilities({ provider });
    },
    staleTime: Infinity,
  });
}

export function providerSkillsQueryOptions(input: {
  provider: ProviderKind;
  cwd: string | null;
  threadId?: string | null;
  spaceId?: string | null;
  agentDir?: string | null;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: [
      ...providerDiscoveryQueryKeys.skills(input.provider, input.cwd, input.agentDir ?? null),
      input.spaceId ?? null,
    ],
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) {
        throw new Error("Skill discovery is unavailable.");
      }
      return api.provider.listSkills({
        provider: input.provider,
        cwd: input.cwd,
        ...(input.threadId ? { threadId: input.threadId } : {}),
        ...(input.spaceId ? { spaceId: input.spaceId } : {}),
        ...(input.agentDir ? { agentDir: input.agentDir } : {}),
      });
    },
    enabled: (input.enabled ?? true) && input.cwd !== null,
    staleTime: 30_000,
    placeholderData: (previous) => previous ?? EMPTY_SKILLS_RESULT,
  });
}

// Unified cross-provider skills catalog (settings page); not filtered by toggles.
// Keep prior data during refetches so Settings does not flicker back to "Scanning..."
// while the server refreshes filesystem discovery in the background.
export function skillsCatalogQueryOptions(input?: { cwd?: string | null; enabled?: boolean }) {
  const cwd = input?.cwd ?? null;
  return queryOptions({
    queryKey: providerDiscoveryQueryKeys.skillsCatalog(cwd),
    queryFn: async (): Promise<ProviderSkillsCatalogResult> => {
      const api = ensureNativeApi();
      return api.provider.listSkillsCatalog(cwd ? { cwd } : {});
    },
    enabled: input?.enabled ?? true,
    staleTime: 30_000,
    placeholderData: (previous) => previous,
  });
}

export function providerCommandsQueryOptions(input: {
  provider: ProviderKind;
  cwd: string | null;
  threadId?: string | null;
  binaryPath?: string | null;
  serverUrl?: string | null;
  // Undefined means "not applicable" (non-OpenCode providers); the body normalizes it.
  experimentalWebSockets?: boolean | undefined;
  agentDir?: string | null;
  enabled?: boolean;
}) {
  const connectionKey = JSON.stringify({
    binaryPath: input.binaryPath ?? null,
    serverUrl: input.serverUrl ?? null,
    experimentalWebSockets: input.experimentalWebSockets ?? null,
  });
  return queryOptions({
    queryKey: providerDiscoveryQueryKeys.commands(
      input.provider,
      input.cwd,
      input.agentDir ?? null,
      connectionKey,
    ),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) {
        throw new Error("Command discovery is unavailable.");
      }
      return api.provider.listCommands({
        provider: input.provider,
        cwd: input.cwd,
        ...(input.threadId ? { threadId: input.threadId } : {}),
        ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
        ...(input.serverUrl ? { serverUrl: input.serverUrl } : {}),
        ...(input.experimentalWebSockets !== undefined
          ? { experimentalWebSockets: input.experimentalWebSockets }
          : {}),
        ...(input.agentDir ? { agentDir: input.agentDir } : {}),
      });
    },
    enabled: (input.enabled ?? true) && input.cwd !== null,
    staleTime: 30_000,
    placeholderData: (previous) => previous ?? EMPTY_COMMANDS_RESULT,
  });
}

/**
 * True only while the first real models fetch is still outstanding.
 * Once discovery settles — with a catalog OR a failure (e.g. missing Cursor
 * CLI, #103) — background refetches must not re-blank the composer picker,
 * and a failed provider must not park the model control on a skeleton.
 */
export function isInitialModelDiscoveryPending(query: {
  readonly isLoading: boolean;
  readonly isFetching: boolean;
  readonly isPlaceholderData: boolean;
}): boolean {
  return query.isLoading || (query.isFetching && query.isPlaceholderData);
}

export function providerModelsQueryOptions(input: {
  provider: ProviderKind;
  binaryPath?: string | null;
  apiEndpoint?: string | null;
  agentDir?: string | null;
  cwd?: string | null;
  enabled?: boolean;
}) {
  const discoveryIdentity = {
    binaryPath: input.binaryPath ?? null,
    apiEndpoint: input.apiEndpoint ?? null,
    agentDir: input.agentDir ?? null,
    cwd: input.cwd ?? null,
  };
  return queryOptions({
    queryKey: providerDiscoveryQueryKeys.models(
      input.provider,
      input.binaryPath ?? null,
      input.apiEndpoint ?? null,
      input.agentDir ?? null,
      input.cwd ?? null,
    ),
    queryFn: async (): Promise<ProviderListModelsResultType> => {
      const api = ensureNativeApi();
      const result = await api.provider.listModels({
        provider: input.provider,
        ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
        ...(input.apiEndpoint ? { apiEndpoint: input.apiEndpoint } : {}),
        ...(input.agentDir ? { agentDir: input.agentDir } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
      });
      if (input.provider === "opencode") {
        writeOpenCodeModelCache(discoveryIdentity, result);
      }
      return result;
    },
    enabled: input.enabled ?? true,
    // Cursor/droid failures are permanent for a session (missing CLI/auth): fail
    // fast so the picker settles to static options instead of spinning (#103).
    retry: input.provider === "droid" || input.provider === "cursor" ? 0 : 3,
    staleTime: input.provider === "droid" ? 5 * 60_000 : 60_000,
    ...(input.provider === "droid" ? { refetchOnWindowFocus: false } : {}),
    ...(input.provider === "opencode"
      ? {
          initialData: () => readOpenCodeModelCache(discoveryIdentity),
          // Persisted data is deliberately stale: render it synchronously, then
          // refresh it without replacing the composer model control.
          initialDataUpdatedAt: 0,
        }
      : {}),
    placeholderData: (previous) => previous ?? EMPTY_MODELS_RESULT,
  });
}

export function providerAgentsQueryOptions(input: {
  provider: ProviderKind;
  binaryPath?: string | null;
  cwd?: string | null;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: providerDiscoveryQueryKeys.agents(
      input.provider,
      input.binaryPath ?? null,
      input.cwd ?? null,
    ),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.provider.listAgents({
        provider: input.provider,
        ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
      });
    },
    enabled: input.enabled ?? true,
    staleTime: 60_000,
    placeholderData: (previous) => previous ?? EMPTY_AGENTS_RESULT,
  });
}

export function providerPluginsQueryOptions(input: {
  provider: ProviderKind;
  cwd: string | null;
  threadId?: string | null;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: providerDiscoveryQueryKeys.plugins(input.provider, input.cwd, input.threadId ?? null),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.provider.listPlugins({
        provider: input.provider,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.threadId ? { threadId: input.threadId } : {}),
      });
    },
    enabled: input.enabled ?? true,
    staleTime: 30_000,
    placeholderData: (previous) => previous ?? EMPTY_PLUGINS_RESULT,
  });
}

export function supportsSkillDiscovery(
  capabilities: ProviderComposerCapabilities | undefined,
): boolean {
  return capabilities?.supportsSkillDiscovery === true;
}

export function supportsNativeSlashCommandDiscovery(
  capabilities: ProviderComposerCapabilities | undefined,
): boolean {
  return capabilities?.supportsNativeSlashCommandDiscovery === true;
}

export function supportsPluginDiscovery(
  capabilities: ProviderComposerCapabilities | undefined,
): boolean {
  return capabilities?.supportsPluginDiscovery === true;
}

export function supportsThreadCompaction(
  capabilities: ProviderComposerCapabilities | undefined,
): boolean {
  return capabilities?.supportsThreadCompaction === true;
}

export function supportsThreadFork(
  capabilities: ProviderComposerCapabilities | undefined,
): boolean {
  return capabilities?.supportsThreadFork === true;
}

export function supportsThreadImport(
  capabilities: ProviderComposerCapabilities | undefined,
): boolean {
  return capabilities?.supportsThreadImport === true;
}
