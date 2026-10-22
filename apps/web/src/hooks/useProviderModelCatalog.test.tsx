// FILE: useProviderModelCatalog.test.tsx
// Purpose: Locks the shared provider-model catalog's memoization and discovery policy.
// Layer: Web hook tests

import type { ProviderKind, ProviderModelDescriptor } from "@penkra/contracts";
import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderModelCatalog } from "./useProviderModelCatalog";
import { useProviderModelCatalog } from "./useProviderModelCatalog";

const mocks = vi.hoisted(() => ({
  useAppSettings: vi.fn(),
  useQuery: vi.fn(),
  useCatalog: vi.fn(),
}));

vi.mock("./useProviderCatalog", () => ({ useProviderCatalog: mocks.useCatalog }));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return { ...actual, useQuery: mocks.useQuery };
});

vi.mock("../appSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../appSettings")>();
  return { ...actual, useAppSettings: mocks.useAppSettings };
});

interface QueryOptionsLike {
  readonly queryKey: readonly unknown[];
  readonly enabled?: boolean;
}

interface QueryResultLike {
  readonly data?: {
    readonly agents?: ReadonlyArray<{ name: string; displayName: string }>;
    readonly cached?: boolean;
    readonly models?: ReadonlyArray<ProviderModelDescriptor>;
    readonly source?: string;
    readonly error?: string | null;
  };
  readonly isFetching: boolean;
  readonly isError: boolean;
  readonly isLoading: boolean;
  readonly isPlaceholderData: boolean;
}

const EMPTY_QUERY: QueryResultLike = {
  isFetching: false,
  isError: false,
  isLoading: false,
  isPlaceholderData: false,
};
const modelQueries = new Map<ProviderKind, QueryResultLike>();
const MODEL_HINTS = { opencode: "openai/gpt-5" } as const;
const SETTINGS = {
  customClaudeModels: [],
  customCodexModels: [],
  customOpenCodeModels: ["openrouter/custom"],
};

function readCatalogRenders(
  input: Parameters<typeof useProviderModelCatalog>[0],
): ProviderModelCatalog[] {
  const results: ProviderModelCatalog[] = [];

  function Probe() {
    const [renderIndex, setRenderIndex] = useState(0);
    results.push(useProviderModelCatalog(input));
    if (renderIndex === 0) {
      setRenderIndex(1);
    }
    return null;
  }

  renderToStaticMarkup(<Probe />);
  expect(results).toHaveLength(2);
  return results;
}

beforeEach(() => {
  modelQueries.clear();
  mocks.useAppSettings.mockReset().mockReturnValue({ settings: SETTINGS });
  mocks.useQuery.mockReset().mockReturnValue({
    data: {
      anonymousRoutes: [],
      connections: ["codex", "claudeAgent", "opencode"].map((harness) => ({
        id: `connection-${harness}`,
        harness,
        lifecycle: "active",
      })),
    },
  });
  mocks.useCatalog.mockReset().mockImplementation((scope: { provider: ProviderKind } | null) => {
    const query = (scope ? modelQueries.get(scope.provider) : undefined) ?? EMPTY_QUERY;
    return Object.assign(query, { loadFailed: query.isError || query.data?.error != null });
  });
});

describe("useProviderModelCatalog", () => {
  it("keeps aggregate identities stable when inputs and query data are unchanged", () => {
    const [first, second] = readCatalogRenders({
      selectedProvider: "opencode",
      discoveryEnabled: true,
      modelHintByProvider: MODEL_HINTS,
    });

    expect(second).toBe(first);
    expect(second?.customModelsByProvider).toBe(first?.customModelsByProvider);
    expect(second?.modelOptionsByProvider).toBe(first?.modelOptionsByProvider);
    expect(second?.loadingModelProviders).toBe(first?.loadingModelProviders);
    expect(second?.unavailableModelProviders).toBe(first?.unavailableModelProviders);
    expect(second?.runtimeModelsByProvider).toBe(first?.runtimeModelsByProvider);
  });

  it("loads models only; folder agents are left to the lazy composer catalog", () => {
    readCatalogRenders({ selectedProvider: "opencode", discoveryEnabled: false });
    expect(
      mocks.useCatalog.mock.calls.every(([, kinds]) => JSON.stringify(kinds) === '["models"]'),
    ).toBe(true);
    expect(mocks.useCatalog.mock.calls.find(([scope]) => scope?.provider === "opencode")?.[2]).toBe(
      true,
    );
    expect(
      mocks.useCatalog.mock.calls.find(([scope]) => scope?.provider === "claudeAgent")?.[2],
    ).toBe(false);
  });

  it("merges a settled runtime catalog with custom models without reporting loading", () => {
    modelQueries.set("opencode", {
      data: {
        models: [{ slug: "openai/gpt-5", name: "OpenAI GPT-5" }],
        source: "managed-connections",
        cached: false,
      },
      isFetching: true,
      isError: false,
      isLoading: false,
      isPlaceholderData: false,
    });

    const catalog = readCatalogRenders({
      selectedProvider: "opencode",
      discoveryEnabled: true,
      modelHintByProvider: MODEL_HINTS,
    }).at(-1);

    expect(catalog?.modelOptionsByProvider.opencode.map((model) => model.slug)).toEqual([
      "openai/gpt-5",
      "openrouter/custom",
    ]);
    expect(catalog?.loadingModelProviders.opencode).toBe(false);
    expect(catalog?.selectedProviderModelsLoading).toBe(false);
    expect(catalog?.runtimeModelsByProvider.opencode).toEqual([
      { slug: "openai/gpt-5", name: "OpenAI GPT-5" },
    ]);
  });

  it("marks Codex unavailable instead of presenting its static fallback as live", () => {
    modelQueries.set("codex", {
      isFetching: false,
      isError: true,
      isLoading: false,
      isPlaceholderData: true,
    });

    const catalog = readCatalogRenders({
      selectedProvider: "codex",
      discoveryEnabled: true,
    }).at(-1);

    expect(catalog?.loadingModelProviders.codex).toBe(false);
    expect(catalog?.unavailableModelProviders.codex).toBe(true);
  });

  it("keeps Codex pending until its authoritative catalog arrives", () => {
    modelQueries.set("codex", {
      isFetching: true,
      isError: false,
      isLoading: true,
      isPlaceholderData: true,
    });

    const catalog = readCatalogRenders({
      selectedProvider: "codex",
      discoveryEnabled: false,
    }).at(-1);

    expect(catalog?.loadingModelProviders.codex).toBe(true);
    expect(catalog?.selectedProviderModelsLoading).toBe(true);
    expect(catalog?.unavailableModelProviders.codex).toBe(false);
  });
});
