import type {
  ProviderConnectionId,
  ProviderKind,
  ServerConfig,
  ServerProviderStatus,
} from "@penkra/contracts";
import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";

export const serverQueryKeys = {
  all: ["server"] as const,
  config: () => ["server", "config"] as const,
  authSession: () => ["server", "auth", "session"] as const,
  environment: () => ["server", "environment"] as const,
  settings: () => ["server", "settings"] as const,
  allProviderUsage: (
    provider?: ProviderKind | null,
    connectionIds?: ReadonlyArray<ProviderConnectionId>,
  ) =>
    ["server", "allProviderUsage", provider ?? null, ...(connectionIds ?? []).toSorted()] as const,
};

export function serverConfigQueryOptions() {
  return queryOptions({
    queryKey: serverQueryKeys.config(),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.server.getConfig();
    },
    staleTime: Infinity,
  });
}

interface ProviderStatusSnapshot {
  readonly revision: number;
  readonly providers: readonly ServerProviderStatus[];
}

const latestProviderStatusSnapshotByQueryClient = new WeakMap<
  QueryClient,
  ProviderStatusSnapshot
>();

function recordProviderStatusSnapshot(
  queryClient: QueryClient,
  providers: readonly ServerProviderStatus[],
): ProviderStatusSnapshot {
  const snapshot = {
    revision: (latestProviderStatusSnapshotByQueryClient.get(queryClient)?.revision ?? 0) + 1,
    providers,
  };
  latestProviderStatusSnapshotByQueryClient.set(queryClient, snapshot);
  return snapshot;
}

/**
 * Folds an authoritative provider snapshot into server.config. Provider streams
 * can win the race against the initial config query, so retain the latest
 * snapshot and apply it after config hydration instead of dropping it.
 */
export async function reconcileServerProviderStatuses(
  queryClient: QueryClient,
  providers: readonly ServerProviderStatus[],
  options?: {
    readonly loadConfig?: () => Promise<ServerConfig>;
  },
): Promise<void> {
  recordProviderStatusSnapshot(queryClient, providers);

  let applied = false;
  queryClient.setQueryData<ServerConfig>(serverQueryKeys.config(), (current) => {
    if (!current) return current;
    applied = true;
    return { ...current, providers };
  });
  if (applied) return;

  const loadConfig =
    options?.loadConfig ??
    (() =>
      queryClient.fetchQuery({
        ...serverConfigQueryOptions(),
        staleTime: 0,
      }));
  const hydratedConfig = await loadConfig();
  const latestProviders =
    latestProviderStatusSnapshotByQueryClient.get(queryClient)?.providers ?? providers;
  queryClient.setQueryData<ServerConfig>(serverQueryKeys.config(), (current) => ({
    ...(current ?? hydratedConfig),
    providers: latestProviders,
  }));
}

/**
 * Refreshes the config projection when the WebSocket reopens without letting
 * the response overwrite a provider snapshot that arrived while it was in flight.
 */
export async function refreshServerConfigAfterTransportOpen(
  queryClient: QueryClient,
  options?: {
    readonly loadConfig?: () => Promise<ServerConfig>;
  },
): Promise<void> {
  const providerRevisionAtStart =
    latestProviderStatusSnapshotByQueryClient.get(queryClient)?.revision ?? 0;
  const loadConfig =
    options?.loadConfig ??
    (() =>
      queryClient.fetchQuery({
        ...serverConfigQueryOptions(),
        staleTime: 0,
      }));
  const config = await loadConfig();
  const latestProviderSnapshot = latestProviderStatusSnapshotByQueryClient.get(queryClient);
  queryClient.setQueryData<ServerConfig>(serverQueryKeys.config(), {
    ...config,
    providers:
      latestProviderSnapshot && latestProviderSnapshot.revision > providerRevisionAtStart
        ? latestProviderSnapshot.providers
        : config.providers,
  });
}

export function serverAuthSessionQueryOptions() {
  return queryOptions({
    queryKey: serverQueryKeys.authSession(),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.server.getAuthSession();
    },
    staleTime: 15_000,
  });
}

export function serverSettingsQueryOptions() {
  return queryOptions({
    queryKey: serverQueryKeys.settings(),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.server.getSettings();
    },
    staleTime: Infinity,
  });
}

// Live usage for the account picker, always scoped to its listed connections.
export function serverAllProviderUsageQueryOptions(input: {
  enabled?: boolean;
  provider?: ProviderKind | null;
  connectionIds: ReadonlyArray<ProviderConnectionId>;
}) {
  const provider = input.provider ?? null;
  const connectionIds = input.connectionIds;
  return queryOptions({
    queryKey: serverQueryKeys.allProviderUsage(provider, connectionIds),
    enabled: input.enabled ?? true,
    staleTime: Infinity,
    refetchOnMount: "always",
    refetchInterval: false,
    refetchOnWindowFocus: false,
    queryFn: async () =>
      ensureNativeApi().server.listProviderUsage({
        ...(provider ? { provider } : {}),
        connectionIds: [...connectionIds],
      }),
  });
}
