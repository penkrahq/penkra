import { describe, expect, it } from "vitest";

import { filterProviderModelsForPicker } from "./providerModelPresentation.ts";
import {
  claudeDefaultModelId,
  claudeModelsListFixture,
  claudePickerModelsFixture,
} from "./claudeModelsListFixture.ts";

describe("provider model picker presentation", () => {
  it("filters OpenCode deprecated and Codex hidden models without changing source catalogs", () => {
    const openCodeCatalog = {
      models: [
        { slug: "provider/old", name: "Old", status: "deprecated" as const },
        { slug: "provider/current", name: "Current", status: "active" as const },
      ],
      source: "sdk",
      cached: false,
    };
    const codexCatalog = {
      models: [
        { slug: "gpt-hidden", name: "Hidden", visibility: "hide" },
        { slug: "codex-auto-review", name: "Codex Auto Review" },
        { slug: "gpt-listed", name: "Listed", visibility: "list" },
      ],
      source: "codex-app-server",
      cached: false,
    };

    expect(filterProviderModelsForPicker("opencode", openCodeCatalog).models).toEqual([
      { slug: "provider/current", name: "Current", status: "active" },
    ]);
    expect(filterProviderModelsForPicker("codex", codexCatalog).models).toEqual([
      { slug: "gpt-listed", name: "Listed", visibility: "list" },
    ]);
    expect(openCodeCatalog.models).toHaveLength(2);
    expect(codexCatalog.models).toHaveLength(3);
  });

  it("keeps the highest version per Claude family from the captured catalog", () => {
    const catalog = {
      models: claudeModelsListFixture.map((slug) => {
        const names: Record<string, string> = {
          "claude-opus-5-5": "Opus 5.5",
          "claude-sonnet-5": "Sonnet 5",
          "claude-fable-5-1": "Fable 5.1",
          "claude-haiku-4-5-20251001": "Haiku 4.5",
          "claude-opus-5": "Opus 5",
          "claude-fable-5": "Fable 5",
          "claude-opus-4-8": "Opus 4.8",
          "claude-opus-4-7": "Opus 4.7",
          "claude-opus-4-6": "Opus 4.6",
          "claude-sonnet-4-6": "Sonnet 4.6",
        };
        return {
          slug,
          name: `${names[slug]}${slug === claudeDefaultModelId ? " (Default)" : ""}`,
          ...(slug === claudeDefaultModelId ? { isDefault: true as const } : {}),
        };
      }),
      source: "claudeAgent",
      cached: false,
    };
    expect(filterProviderModelsForPicker("claudeAgent", catalog).models).toEqual(
      claudePickerModelsFixture,
    );
    expect(catalog.models).toHaveLength(claudeModelsListFixture.length);
  });

  it("parses version-first IDs, ignores dates, preserves opaque IDs, and always keeps the default", () => {
    const catalog = {
      models: [
        { slug: "claude-3-5-haiku-20241022", name: "Haiku 3.5" },
        { slug: "claude-4-5-haiku-20251022", name: "Haiku 4.5" },
        { slug: "claude-3-7-sonnet-20250219", name: "Sonnet 3.7" },
        { slug: "claude-4-0-sonnet-20250929", name: "Sonnet 4.0" },
        { slug: "claude-opus-5-5", name: "Opus 5.5" },
        { slug: "claude-opus-4-7", name: "Opus 4.7 (Default)", isDefault: true as const },
        { slug: "claude-future-model", name: "Unparsed Claude model" },
        { slug: "opaque-model", name: "Opaque model" },
      ],
      source: "claudeAgent",
      cached: false,
    };
    expect(
      filterProviderModelsForPicker("claudeAgent", catalog).models.map((model) => model.slug),
    ).toEqual([
      "claude-4-5-haiku-20251022",
      "claude-4-0-sonnet-20250929",
      "claude-opus-5-5",
      "claude-opus-4-7",
      "claude-future-model",
      "opaque-model",
    ]);
  });
});
