// FILE: useProviderModelCatalog.ts
// Purpose: Read Connection-scoped model catalogs for the three provider pickers.

import type {
  ProviderConnectionId,
  ProviderKind,
  ProviderModelDescriptor,
} from "@penkra/contracts";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { filterProviderModelsForPicker } from "@penkra/shared/providerModelPresentation";
import { useProviderCatalog } from "./useProviderCatalog";
import { providerConnectionsQueryOptions } from "../lib/providerConnectionsReactQuery";

import { getAppModelOptions, getCustomModelsByProvider, useAppSettings } from "../appSettings";
import { resolveRuntimeModelDescriptor } from "../components/chat/runtimeModelCapabilities";
import { isInitialModelDiscoveryPending } from "../lib/providerDiscoveryReactQuery";
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
  modelHintByProvider?: Partial<Record<ProviderKind, string | null>>;
  prefetchProviders?: ReadonlyArray<ProviderKind>;
  routeByProvider?: Partial<
    Record<
      ProviderKind,
      { connectionId: ProviderConnectionId | null; internalProviderId: string | null }
    >
  >;
}): ProviderModelCatalog {
  const { settings, serverSettings } = useAppSettings();
  const connections = useQuery(providerConnectionsQueryOptions());
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

  const modelScope = (provider: ProviderKind) => {
    const active =
      connections.data?.connections.filter(
        (connection) => connection.harness === provider && connection.lifecycle === "active",
      ) ?? [];
    const selected = serverSettings?.providers[provider]?.defaultConnectionId;
    const connectionId =
      input.routeByProvider !== undefined
        ? input.routeByProvider[provider]?.connectionId
        : selected !== undefined
          ? selected
          : active.length === 1
            ? active[0]!.id
            : active.length === 0 &&
                connections.data?.anonymousRoutes.some((route) => route.harness === provider)
              ? null
              : undefined;
    return connectionId === undefined ? null : { provider, connectionId };
  };
  const codexModels = useProviderCatalog(modelScope("codex"), ["models"], shouldDiscover("codex"));
  const claudeModels = useProviderCatalog(
    modelScope("claudeAgent"),
    ["models"],
    shouldDiscover("claudeAgent"),
  );
  const openCodeModels = useProviderCatalog(
    modelScope("opencode"),
    ["models"],
    shouldDiscover("opencode"),
  );
  const modelQueries = useMemo(
    () => ({ codex: codexModels, claudeAgent: claudeModels, opencode: openCodeModels }),
    [claudeModels, codexModels, openCodeModels],
  );

  const runtimeModelsByProvider = useMemo(
    () => ({
      codex: filterProviderModelsForPicker("codex", { models: codexModels.data?.models ?? [] })
        .models,
      claudeAgent: filterProviderModelsForPicker("claudeAgent", {
        models: claudeModels.data?.models ?? [],
      }).models,
      opencode: filterProviderModelsForPicker("opencode", {
        models: openCodeModels.data?.models ?? [],
      }).models,
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
        modelQueries[provider].loadFailed &&
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

  return useMemo(
    () => ({
      customModelsByProvider,
      modelOptionsByProvider,
      loadingModelProviders,
      unavailableModelProviders,
      runtimeModelsByProvider,
      selectedRuntimeModel,
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
      selectedRuntimeModel,
      unavailableModelProviders,
    ],
  );
}
