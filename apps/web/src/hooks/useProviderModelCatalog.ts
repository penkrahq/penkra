// FILE: useProviderModelCatalog.ts
// Purpose: Shared three-provider model and agent discovery catalog.

import type {
  ProviderAgentDescriptor,
  ProviderConnectionId,
  ProviderKind,
  ProviderModelDescriptor,
} from "@penkra/contracts";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { getAppModelOptions, getCustomModelsByProvider, useAppSettings } from "../appSettings";
import { resolveRuntimeModelDescriptor } from "../components/chat/runtimeModelCapabilities";
import {
  isInitialModelDiscoveryPending,
  providerAgentsQueryOptions,
  providerModelsQueryOptions,
} from "../lib/providerDiscoveryReactQuery";
import { mergeDynamicModelOptions, type ProviderModelOption } from "../providerModelOptions";

export interface ProviderModelCatalog {
  customModelsByProvider: ReturnType<typeof getCustomModelsByProvider>;
  modelOptionsByProvider: Record<
    ProviderKind,
    ReadonlyArray<ProviderModelOption & { isCustom?: boolean }>
  >;
  loadingModelProviders: Partial<Record<ProviderKind, boolean>>;
  unavailableModelProviders: Partial<Record<ProviderKind, boolean>>;
  runtimeModelsByProvider: Record<ProviderKind, ReadonlyArray<ProviderModelDescriptor>>;
  selectedRuntimeModel: ProviderModelDescriptor | undefined;
  selectedRuntimeAgents: ReadonlyArray<ProviderAgentDescriptor>;
  selectedProviderModelsLoading: boolean;
  selectedProviderRuntimeModelDiscoveryPending: boolean;
}

const PROVIDERS = [
  "codex",
  "claudeAgent",
  "opencode",
] as const satisfies ReadonlyArray<ProviderKind>;

export function useProviderModelCatalog(input: {
  selectedProvider: ProviderKind;
  discoveryEnabled: boolean;
  cwd?: string | null;
  modelHintByProvider?: Partial<Record<ProviderKind, string | null>>;
  prefetchProviders?: ReadonlyArray<ProviderKind>;
  agentDiscoveryPolicy?: "selected" | "eager-core";
  routeByProvider?: Partial<
    Record<
      ProviderKind,
      { connectionId: ProviderConnectionId | null; internalProviderId: string | null }
    >
  >;
}): ProviderModelCatalog {
  const { settings, serverSettings } = useAppSettings();
  const cwd = input.cwd ?? null;
  const customModelsByProvider = useMemo(() => getCustomModelsByProvider(settings), [settings]);
  const prefetchProviderSet = useMemo(
    () => (input.prefetchProviders ? new Set(input.prefetchProviders) : null),
    [input.prefetchProviders],
  );
  const shouldDiscover = useCallback(
    (provider: ProviderKind, eager = input.discoveryEnabled) =>
      serverSettings?.providers[provider]?.enabled !== false &&
      (input.routeByProvider === undefined || input.routeByProvider[provider] !== undefined) &&
      (provider === input.selectedProvider ||
        (eager && (prefetchProviderSet?.has(provider) ?? true))),
    [
      input.discoveryEnabled,
      input.routeByProvider,
      input.selectedProvider,
      prefetchProviderSet,
      serverSettings,
    ],
  );

  const modelQueryInput = (provider: ProviderKind) => ({
    provider,
    ...input.routeByProvider?.[provider],
    enabled: shouldDiscover(provider),
  });

  const codexModels = useQuery(providerModelsQueryOptions(modelQueryInput("codex")));
  const claudeModels = useQuery(providerModelsQueryOptions(modelQueryInput("claudeAgent")));
  const openCodeModels = useQuery(
    providerModelsQueryOptions({ ...modelQueryInput("opencode"), cwd }),
  );
  const modelQueries = useMemo(
    () => ({ codex: codexModels, claudeAgent: claudeModels, opencode: openCodeModels }),
    [claudeModels, codexModels, openCodeModels],
  );

  const eagerCore = input.agentDiscoveryPolicy === "eager-core";
  const agentQueryInput = (provider: ProviderKind, eager = eagerCore) => ({
    provider,
    ...input.routeByProvider?.[provider],
    enabled: shouldDiscover(provider, eager),
  });
  const codexAgents = useQuery(providerAgentsQueryOptions(agentQueryInput("codex")));
  const claudeAgents = useQuery(providerAgentsQueryOptions(agentQueryInput("claudeAgent")));
  const openCodeAgents = useQuery(
    providerAgentsQueryOptions({
      ...agentQueryInput("opencode", input.discoveryEnabled),
      cwd,
    }),
  );
  const agentQueries = { codex: codexAgents, claudeAgent: claudeAgents, opencode: openCodeAgents };

  const runtimeModelsByProvider = useMemo(
    () => ({
      codex: codexModels.data?.models ?? [],
      claudeAgent: claudeModels.data?.models ?? [],
      opencode: openCodeModels.data?.models ?? [],
    }),
    [claudeModels.data?.models, codexModels.data?.models, openCodeModels.data?.models],
  );

  const modelOptionsByProvider = useMemo(() => {
    const result = {} as Record<
      ProviderKind,
      ReadonlyArray<ProviderModelOption & { isCustom?: boolean }>
    >;
    for (const provider of PROVIDERS) {
      const staticOptions = getAppModelOptions(
        provider,
        customModelsByProvider[provider],
        input.modelHintByProvider?.[provider],
      );
      const dynamicModels = runtimeModelsByProvider[provider];
      result[provider] =
        dynamicModels.length > 0
          ? mergeDynamicModelOptions({ provider, staticOptions, dynamicModels })
          : staticOptions;
    }
    return result;
  }, [customModelsByProvider, input.modelHintByProvider, runtimeModelsByProvider]);

  const loadingModelProviders = useMemo(() => {
    const result: Partial<Record<ProviderKind, boolean>> = {};
    for (const provider of PROVIDERS) {
      const query = modelQueries[provider];
      result[provider] = shouldDiscover(provider) && isInitialModelDiscoveryPending(query);
    }
    return result;
  }, [modelQueries, shouldDiscover]);

  const unavailableModelProviders = useMemo(() => {
    const result: Partial<Record<ProviderKind, boolean>> = {};
    for (const provider of PROVIDERS) {
      result[provider] =
        shouldDiscover(provider) &&
        modelQueries[provider].isError &&
        runtimeModelsByProvider[provider].length === 0;
    }
    return result;
  }, [modelQueries, runtimeModelsByProvider, shouldDiscover]);

  const selectedQuery = modelQueries[input.selectedProvider];
  const selectedProviderRuntimeModelDiscoveryPending =
    loadingModelProviders[input.selectedProvider] ?? false;
  const selectedRuntimeModel = resolveRuntimeModelDescriptor({
    provider: input.selectedProvider,
    model: input.modelHintByProvider?.[input.selectedProvider] ?? null,
    runtimeModels: runtimeModelsByProvider[input.selectedProvider],
  });
  const selectedAgentData = agentQueries[input.selectedProvider].data?.agents;
  const selectedRuntimeAgents = useMemo(
    () =>
      (selectedAgentData ?? []).map((agent) =>
        agent.description
          ? { name: agent.name, displayName: agent.displayName, description: agent.description }
          : { name: agent.name, displayName: agent.displayName },
      ),
    [selectedAgentData],
  );

  return useMemo(
    () => ({
      customModelsByProvider,
      modelOptionsByProvider,
      loadingModelProviders,
      unavailableModelProviders,
      runtimeModelsByProvider,
      selectedRuntimeModel,
      selectedRuntimeAgents,
      selectedProviderModelsLoading:
        selectedProviderRuntimeModelDiscoveryPending ||
        selectedQuery.isLoading ||
        (selectedQuery.isFetching && selectedQuery.data === undefined),
      selectedProviderRuntimeModelDiscoveryPending,
    }),
    [
      customModelsByProvider,
      loadingModelProviders,
      modelOptionsByProvider,
      runtimeModelsByProvider,
      selectedProviderRuntimeModelDiscoveryPending,
      selectedQuery.data,
      selectedQuery.isFetching,
      selectedQuery.isLoading,
      selectedRuntimeAgents,
      selectedRuntimeModel,
      unavailableModelProviders,
    ],
  );
}
