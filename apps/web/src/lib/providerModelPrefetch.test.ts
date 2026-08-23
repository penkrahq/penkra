// FILE: providerModelPrefetch.test.ts
// Purpose: Verifies new-thread model prefetch resolves providers/cwds and hits
//          the same React Query keys ChatView uses for listModels.
// Layer: Web lib tests

import type { ProviderKind } from "@penkra/contracts";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  prefetchProviderModelsForNewThread,
  providerModelsPrefetchQueryOptions,
  resolveNewThreadModelPrefetchCwd,
  resolveNewThreadModelPrefetchProvider,
  type ProviderModelPrefetchSettings,
} from "./providerModelPrefetch";
import { providerDiscoveryQueryKeys } from "./providerDiscoveryReactQuery";

afterEach(() => {
  vi.restoreAllMocks();
});

function makeSettings(
  overrides: Partial<ProviderModelPrefetchSettings> = {},
): ProviderModelPrefetchSettings {
  return {
    defaultProvider: "codex",
    ...overrides,
  };
}

describe("resolveNewThreadModelPrefetchProvider", () => {
  it("prefers draft, then sticky, then project default, then app default", () => {
    expect(
      resolveNewThreadModelPrefetchProvider({
        draftActiveProvider: "claudeAgent",
        stickyActiveProvider: "codex",
        projectDefaultProvider: "opencode",
        defaultProvider: "codex",
      }),
    ).toBe("claudeAgent");

    expect(
      resolveNewThreadModelPrefetchProvider({
        draftActiveProvider: null,
        stickyActiveProvider: "codex",
        projectDefaultProvider: "opencode",
        defaultProvider: "codex",
      }),
    ).toBe("codex");

    expect(
      resolveNewThreadModelPrefetchProvider({
        stickyActiveProvider: null,
        projectDefaultProvider: "opencode",
        defaultProvider: "codex",
      }),
    ).toBe("opencode");

    expect(
      resolveNewThreadModelPrefetchProvider({
        projectDefaultProvider: null,
        defaultProvider: "claudeAgent",
      }),
    ).toBe("claudeAgent");
  });
});

describe("resolveNewThreadModelPrefetchCwd", () => {
  it("prefers draft worktree, then project cwd, then server cwd", () => {
    expect(
      resolveNewThreadModelPrefetchCwd({
        draftWorkingDirectory: "/tmp/worktree",
        projectCwd: "/tmp/project",
        serverCwd: "/tmp/server",
      }),
    ).toBe("/tmp/worktree");

    expect(
      resolveNewThreadModelPrefetchCwd({
        projectCwd: "/tmp/project",
        serverCwd: "/tmp/server",
      }),
    ).toBe("/tmp/project");

    expect(
      resolveNewThreadModelPrefetchCwd({
        projectCwd: null,
        serverCwd: "/tmp/server",
      }),
    ).toBe("/tmp/server");
  });
});

describe("providerModelsPrefetchQueryOptions", () => {
  it("matches ChatView cache keys for live providers", () => {
    const settings = makeSettings();

    const openCodeOptions = providerModelsPrefetchQueryOptions({
      provider: "opencode",
      settings,
      cwd: "/tmp/project",
    });
    expect(openCodeOptions.queryKey).toEqual(
      providerDiscoveryQueryKeys.models("opencode", null, null, null, "/tmp/project"),
    );

    const codexOptions = providerModelsPrefetchQueryOptions({
      provider: "codex",
      settings,
    });
    expect(codexOptions.queryKey).toEqual(
      providerDiscoveryQueryKeys.models("codex", null, null, null, null),
    );
  });
});

describe("prefetchProviderModelsForNewThread", () => {
  it("prefetches models and agents for the resolved provider", async () => {
    const queryClient = new QueryClient();
    const prefetchQuery = vi.spyOn(queryClient, "prefetchQuery").mockResolvedValue(undefined);

    prefetchProviderModelsForNewThread(queryClient, {
      provider: "opencode" satisfies ProviderKind,
      settings: makeSettings(),
      cwd: "/tmp/project",
    });

    expect(prefetchQuery).toHaveBeenCalledTimes(3);
    expect(prefetchQuery.mock.calls[0]?.[0].queryKey).toEqual(
      providerDiscoveryQueryKeys.models("opencode", null, null, null, "/tmp/project"),
    );
    expect(prefetchQuery.mock.calls[1]?.[0].queryKey).toEqual(
      providerDiscoveryQueryKeys.agents("opencode", null, "/tmp/project"),
    );
    expect(prefetchQuery.mock.calls[2]?.[0].queryKey).toEqual(
      providerDiscoveryQueryKeys.composerCapabilities("opencode"),
    );
  });

  it("prefetches models, agents, and capabilities for Codex", async () => {
    const queryClient = new QueryClient();
    const prefetchQuery = vi.spyOn(queryClient, "prefetchQuery").mockResolvedValue(undefined);

    prefetchProviderModelsForNewThread(queryClient, {
      provider: "codex",
      settings: makeSettings(),
    });

    expect(prefetchQuery).toHaveBeenCalledTimes(3);
    expect(prefetchQuery.mock.calls[0]?.[0].queryKey).toEqual(
      providerDiscoveryQueryKeys.models("codex", null, null, null, null),
    );
    expect(prefetchQuery.mock.calls[1]?.[0].queryKey).toEqual(
      providerDiscoveryQueryKeys.agents("codex", null, null),
    );
    expect(prefetchQuery.mock.calls[2]?.[0].queryKey).toEqual(
      providerDiscoveryQueryKeys.composerCapabilities("codex"),
    );
  });
});
