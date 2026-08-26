// FILE: providerModelOptions.test.ts
// Purpose: Verifies provider-aware model-name formatting for picker and composer labels.
// Layer: Web unit tests
// Depends on: providerModelOptions shared formatting helpers.

import { describe, expect, it } from "vitest";

import {
  buildModelSelection,
  buildNextProviderOptions,
  buildProviderOptionPatch,
  formatProviderModelOptionName,
  groupProviderModelOptions,
  groupProviderModelOptionsWithFavorites,
  mergeDynamicModelOptions,
  providerModelCostMultiplierLabel,
  resolveModelGroupDefaultOpen,
  shouldUseCollapsibleModelGroups,
  type ProviderModelOption,
} from "./providerModelOptions";

describe("formatProviderModelOptionName", () => {
  it("humanizes unknown OpenCode runtime model slugs using the model identifier", () => {
    expect(
      formatProviderModelOptionName({
        provider: "opencode",
        slug: "opencode-go/kimi-k2.6",
      }),
    ).toBe("Kimi K2.6");
  });

  it("keeps known OpenCode-backed models on their shared display names", () => {
    expect(
      formatProviderModelOptionName({
        provider: "opencode",
        slug: "openai/gpt-5",
      }),
    ).toBe("GPT-5");
  });

  it("leaves non-OpenCode unknown slugs unchanged", () => {
    expect(
      formatProviderModelOptionName({
        provider: "codex",
        slug: "custom/internal-model",
      }),
    ).toBe("custom/internal-model");
  });
});

describe("mergeDynamicModelOptions", () => {
  it("uses the signed-in Codex catalog without re-adding unavailable static models", () => {
    expect(
      mergeDynamicModelOptions({
        provider: "codex",
        staticOptions: [
          { slug: "gpt-5.2", name: "GPT-5.2" },
          { slug: "custom/private-model", name: "Custom model", isCustom: true },
        ],
        dynamicModels: [{ slug: "gpt-5.6-sol", name: "GPT-5.6 Sol" }],
      }),
    ).toEqual([
      { slug: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
      { slug: "custom/private-model", name: "Custom model", isCustom: true },
    ]);
  });

  it("does not expose Codex's internal auto-review model", () => {
    expect(
      mergeDynamicModelOptions({
        provider: "codex",
        staticOptions: [],
        dynamicModels: [
          { slug: "codex-auto-review", name: "Codex Auto Review" },
          { slug: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
        ],
      }),
    ).toEqual([{ slug: "gpt-5.6-luna", name: "GPT-5.6 Luna" }]);
  });

  it("uses Claude's provider-derived display label without rewriting future models", () => {
    expect(
      mergeDynamicModelOptions({
        provider: "claudeAgent",
        staticOptions: [
          { slug: "claude-opus-4-8", name: "Claude Opus 4.8" },
          { slug: "custom/private-model", name: "Custom model", isCustom: true },
        ],
        dynamicModels: [
          {
            slug: "claude-opus-6",
            name: "Opus 6",
            description: "Opus 6",
          },
        ],
      }),
    ).toEqual([
      {
        slug: "claude-opus-6",
        name: "Opus 6",
        description: "Opus 6",
      },
      { slug: "custom/private-model", name: "Custom model", isCustom: true },
    ]);
  });

  it("keeps a live Claude selector alias provider-owned instead of mapping it to an old model", () => {
    expect(
      mergeDynamicModelOptions({
        provider: "claudeAgent",
        staticOptions: [{ slug: "claude-opus-4-8", name: "Claude Opus 4.8" }],
        dynamicModels: [{ slug: "opus", name: "Opus", description: "Opus 6" }],
      }),
    ).toEqual([{ slug: "opus", name: "Opus", description: "Opus 6" }]);
  });

  it("preserves runtime descriptions without inventing them for custom models", () => {
    const options = mergeDynamicModelOptions({
      provider: "opencode",
      staticOptions: [{ slug: "custom:model", name: "Custom model", isCustom: true }],
      dynamicModels: [
        {
          slug: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          description: " 0.4x Factory token rate ",
        },
        { slug: "custom:model", name: "Custom model" },
      ],
    });

    expect(options).toEqual([
      {
        slug: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        description: "0.4x Factory token rate",
      },
      { slug: "custom:model", name: "Custom model" },
    ]);
  });
});

describe("providerModelCostMultiplierLabel", () => {
  it("formats live provider multipliers without hardcoding their values", () => {
    expect(providerModelCostMultiplierLabel("0.38x Factory token rate")).toBe("0.38×");
    expect(providerModelCostMultiplierLabel("12x Factory token rate")).toBe("12×");
  });

  it("ignores descriptions that do not begin with a multiplier", () => {
    expect(providerModelCostMultiplierLabel("Launch Pricing")).toBeNull();
    expect(providerModelCostMultiplierLabel()).toBeNull();
  });
});

describe("buildProviderOptionPatch", () => {
  it("passes through option ids unchanged", () => {
    expect(buildProviderOptionPatch("codex", "reasoningEffort", "xhigh")).toEqual({
      reasoningEffort: "xhigh",
    });
    expect(buildProviderOptionPatch("opencode", "reasoningEffort", "high")).toEqual({
      reasoningEffort: "high",
    });
  });
});

describe("groupProviderModelOptions", () => {
  it("groups provider models by upstream provider", () => {
    const options = [
      {
        slug: "anthropic/claude-sonnet",
        name: "Claude Sonnet",
        upstreamProviderId: "anthropic",
        upstreamProviderName: "Anthropic",
      },
      {
        slug: "openai/gpt-5",
        name: "GPT-5",
        upstreamProviderId: "openai",
        upstreamProviderName: "OpenAI",
      },
    ] satisfies ProviderModelOption[];

    const groupedOptions = groupProviderModelOptions(options);

    expect(groupedOptions.map((group) => group.label)).toEqual(["Anthropic", "OpenAI"]);
  });
});

describe("groupProviderModelOptionsWithFavorites", () => {
  it("adds a favourites group ahead of the normal provider groups", () => {
    const options = [
      {
        slug: "anthropic/claude-sonnet",
        name: "Claude Sonnet",
        upstreamProviderId: "anthropic",
        upstreamProviderName: "Anthropic",
      },
      {
        slug: "openai/gpt-5",
        name: "GPT-5",
        upstreamProviderId: "openai",
        upstreamProviderName: "OpenAI",
      },
    ] satisfies ProviderModelOption[];

    const groupedOptions = groupProviderModelOptionsWithFavorites({
      options,
      favoriteSlugs: new Set(["openai/gpt-5"]),
    });

    expect(groupedOptions.map((group) => group.label)).toEqual(["Favourites", "Anthropic"]);
    expect(groupedOptions[0]?.options.map((option) => option.slug)).toEqual(["openai/gpt-5"]);
    expect(groupedOptions.flatMap((group) => group.options.map((option) => option.slug))).toEqual([
      "openai/gpt-5",
      "anthropic/claude-sonnet",
    ]);
  });
});

describe("collapsible model group helpers", () => {
  it("enables collapsible sections only for long grouped lists while not searching", () => {
    expect(shouldUseCollapsibleModelGroups(2, false)).toBe(false);
    expect(shouldUseCollapsibleModelGroups(3, false)).toBe(true);
    expect(shouldUseCollapsibleModelGroups(4, true)).toBe(false);
  });

  it("keeps favourites and the active model group expanded by default", () => {
    expect(
      resolveModelGroupDefaultOpen({
        groupKey: "__favorites__",
        options: [{ slug: "openai/gpt-5", name: "GPT-5" }],
        activeModel: "anthropic/claude-sonnet",
        groupCount: 4,
      }),
    ).toBe(true);
    expect(
      resolveModelGroupDefaultOpen({
        groupKey: "openai",
        options: [{ slug: "openai/gpt-5", name: "GPT-5" }],
        activeModel: "openai/gpt-5",
        groupCount: 4,
      }),
    ).toBe(true);
    expect(
      resolveModelGroupDefaultOpen({
        groupKey: "anthropic",
        options: [{ slug: "anthropic/claude-sonnet", name: "Claude Sonnet" }],
        activeModel: "openai/gpt-5",
        groupCount: 4,
      }),
    ).toBe(false);
  });
});
