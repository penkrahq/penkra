// FILE: providerModelPrefetch.ts
// Purpose: Warm provider model discovery and composer capabilities into the
//          React Query cache before a new thread mounts ChatView, so the
//          composer can skip the "Loading models" skeleton and capability
//          round-trips on the common new-thread path.
// Layer: Web lib
// Exports: resolve + prefetch helpers that mirror ChatView's listModels query keys.

import type { ProviderKind } from "@penkra/contracts";
import type { QueryClient } from "@tanstack/react-query";

import type { AppSettings } from "../appSettings";
import { resolveProviderDiscoveryCwd } from "./providerDiscovery";
import {
  providerAgentsQueryOptions,
  providerComposerCapabilitiesQueryOptions,
  providerModelsQueryOptions,
} from "./providerDiscoveryReactQuery";

export type ProviderModelPrefetchSettings = Pick<AppSettings, "defaultProvider">;

export function resolveNewThreadModelPrefetchProvider(input: {
  draftActiveProvider?: ProviderKind | null | undefined;
  stickyActiveProvider?: ProviderKind | null | undefined;
  projectDefaultProvider?: ProviderKind | null | undefined;
  defaultProvider: ProviderKind;
}): ProviderKind {
  return (
    input.draftActiveProvider ??
    input.stickyActiveProvider ??
    input.projectDefaultProvider ??
    input.defaultProvider ??
    "codex"
  );
}

export function resolveNewThreadModelPrefetchCwd(input: {
  draftWorkingDirectory?: string | null | undefined;
  projectCwd?: string | null | undefined;
  serverCwd?: string | null | undefined;
}): string | null {
  return resolveProviderDiscoveryCwd({
    activeThreadWorkingDirectory: input.draftWorkingDirectory ?? null,
    activeProjectCwd: input.projectCwd ?? null,
    serverCwd: input.serverCwd ?? null,
  });
}

/**
 * Build the same listModels query options ChatView uses for a provider, so a
 * prefetch lands on the exact cache key the composer will read on mount.
 */
export function providerModelsPrefetchQueryOptions(input: {
  provider: ProviderKind;
  settings: ProviderModelPrefetchSettings;
  cwd?: string | null;
}) {
  const { provider } = input;
  const cwd = input.cwd ?? null;

  switch (provider) {
    case "claudeAgent":
      return providerModelsQueryOptions({ provider: "claudeAgent" });
    case "codex":
      return providerModelsQueryOptions({ provider: "codex" });
    case "opencode":
      return providerModelsQueryOptions({
        provider: "opencode",
        cwd,
      });
  }
}

function providerAgentsPrefetchQueryOptions(input: {
  provider: ProviderKind;
  settings: ProviderModelPrefetchSettings;
  cwd?: string | null;
}) {
  const { provider } = input;
  const cwd = input.cwd ?? null;

  switch (provider) {
    case "claudeAgent":
      return providerAgentsQueryOptions({ provider: "claudeAgent" });
    case "codex":
      return providerAgentsQueryOptions({ provider: "codex" });
    case "opencode":
      return providerAgentsQueryOptions({
        provider: "opencode",
        cwd,
      });
    default:
      return null;
  }
}

export function prefetchProviderModelsForNewThread(
  queryClient: QueryClient,
  input: {
    provider: ProviderKind;
    settings: ProviderModelPrefetchSettings;
    cwd?: string | null;
  },
): void {
  const cwd = input.cwd ?? null;
  void queryClient.prefetchQuery(
    providerModelsPrefetchQueryOptions({
      provider: input.provider,
      settings: input.settings,
      cwd,
    }),
  );

  // Agent/mode lists ride along for providers that surface them next to models.
  const agentsOptions = providerAgentsPrefetchQueryOptions({
    provider: input.provider,
    settings: input.settings,
    cwd,
  });
  if (agentsOptions) {
    void queryClient.prefetchQuery(agentsOptions);
  }

  // Composer capabilities gate composer affordances on ChatView mount; the query
  // has staleTime Infinity, so this costs one IPC per provider per session.
  void queryClient.prefetchQuery(providerComposerCapabilitiesQueryOptions(input.provider));
}
