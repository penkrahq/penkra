import { describe, expect, it } from "vitest";

import {
  EMPTY_MODEL_CAPABILITIES,
  applyClaudePromptEffortPrefix,
  buildProviderOptionSelectionsFromDescriptors,
  claudeSelectionRequiresRestart,
  formatModelDisplayName,
  getDefaultEffort,
  getModelCapabilities,
  getModelOptions,
  getProviderOptionCurrentLabel,
  getProviderOptionDescriptors,
  hasAutoCompactWindowOption,
  hasContextWindowOption,
  hasEffortLevel,
  humanizeModelSlug,
  isClaudeUltrathinkPrompt,
  normalizeClaudeModelOptions,
  normalizeCodexModelOptions,
  normalizeModelSlug,
  normalizeOpenCodeModelOptions,
  resolveApiModelId,
  resolveModelSlug,
  resolveSelectableModel,
} from "./model";

describe("model identity", () => {
  it("preserves exact provider-reported and custom identities", () => {
    expect(normalizeModelSlug("  vendor/model-v3  ", "opencode")).toBe("vendor/model-v3");
    expect(normalizeModelSlug("sonnet", "claudeAgent")).toBe("sonnet");
    expect(normalizeModelSlug("5.5", "codex")).toBe("5.5");
    expect(resolveModelSlug("custom/internal-model", "codex")).toBe("custom/internal-model");
  });

  it("does not invent a model when no identity exists", () => {
    expect(normalizeModelSlug(" ")).toBeNull();
    expect(resolveModelSlug(undefined, "claudeAgent")).toBeNull();
    expect(getModelOptions("codex")).toEqual([]);
    expect(getModelOptions("claudeAgent")).toEqual([]);
    expect(getModelOptions("opencode")).toEqual([]);
  });

  it("selects only catalog entries by exact slug or display name", () => {
    const options = [
      { slug: "provider/model-a", name: "Model A" },
      { slug: "provider/model-b", name: "Model B" },
    ];
    expect(resolveSelectableModel("opencode", "provider/model-b", options)).toBe(
      "provider/model-b",
    );
    expect(resolveSelectableModel("opencode", "model a", options)).toBe("provider/model-a");
    expect(resolveSelectableModel("opencode", "provider/model-c", options)).toBeNull();
  });
});

describe("capabilities", () => {
  const capabilities = {
    ...EMPTY_MODEL_CAPABILITIES,
    reasoningEffortLevels: [
      { value: "low", label: "Low" },
      { value: "high", label: "High", isDefault: true as const },
    ],
    contextWindowOptions: [{ value: "large", label: "Large", isDefault: true as const }],
    autoCompactWindowOptions: [{ value: "early", label: "Early" }],
    supportsFastMode: true,
  };

  it("uses runtime-shaped capability data generically", () => {
    expect(getDefaultEffort(capabilities)).toBe("high");
    expect(hasEffortLevel(capabilities, "low")).toBe(true);
    expect(hasEffortLevel(capabilities, "max")).toBe(false);
    expect(hasContextWindowOption(capabilities, "large")).toBe(true);
    expect(hasAutoCompactWindowOption(capabilities, "early")).toBe(true);
  });

  it("has no model-name capability lookup fallback", () => {
    expect(getModelCapabilities("codex", "any-provider-model")).toEqual(EMPTY_MODEL_CAPABILITIES);
  });

  it("serializes generic option descriptors", () => {
    const descriptors = getProviderOptionDescriptors({
      provider: "codex",
      caps: capabilities,
      selections: { reasoningEffort: "low", fastMode: true },
    });
    expect(getProviderOptionCurrentLabel(descriptors[0])).toBe("Low");
    expect(buildProviderOptionSelectionsFromDescriptors(descriptors)).toEqual([
      { id: "reasoningEffort", value: "low" },
      { id: "contextWindow", value: "large" },
      { id: "fastMode", value: true },
    ]);
  });
});

describe("option normalization", () => {
  it("preserves explicit Codex options without guessing model defaults", () => {
    expect(normalizeCodexModelOptions("runtime-model", { reasoningEffort: "high" })).toEqual({
      reasoningEffort: "high",
    });
    expect(normalizeCodexModelOptions("runtime-model", { fastMode: false })).toBeUndefined();
  });

  it("preserves explicit Claude options and migrates the legacy window key", () => {
    expect(
      normalizeClaudeModelOptions("runtime-model", {
        effort: "max",
        thinking: false,
        fastMode: true,
        contextWindow: "1m",
      }),
    ).toEqual({ effort: "max", thinking: false, fastMode: true, autoCompactWindow: "1m" });
  });

  it("normalizes OpenCode values without a model catalog", () => {
    expect(normalizeOpenCodeModelOptions({ variant: " high ", agent: " build " })).toEqual({
      variant: "high",
      agent: "build",
    });
  });
});

describe("Claude runtime selection", () => {
  const selection = (effort?: string) =>
    ({
      provider: "claudeAgent" as const,
      model: "runtime-model",
      ...(effort ? { options: { effort } } : {}),
    }) as Parameters<typeof claudeSelectionRequiresRestart>[1];

  it("restarts only when the spawn-fixed max effort changes", () => {
    expect(claudeSelectionRequiresRestart(selection("high"), selection("max"))).toBe(true);
    expect(claudeSelectionRequiresRestart(selection("max"), selection("high"))).toBe(true);
    expect(claudeSelectionRequiresRestart(selection("low"), selection("high"))).toBe(false);
    expect(claudeSelectionRequiresRestart(undefined, selection("max"))).toBe(false);
  });

  it("keeps the selected native API model identity", () => {
    expect(resolveApiModelId(selection("high"))).toBe("runtime-model");
  });
});

describe("display and prompt helpers", () => {
  it("humanizes unscoped ids and preserves scoped custom ids", () => {
    expect(humanizeModelSlug("some-model_name")).toBe("Some Model Name");
    expect(formatModelDisplayName("vendor/model-v3")).toBe("vendor/model-v3");
  });

  it("applies ultrathink exactly once", () => {
    expect(applyClaudePromptEffortPrefix("Investigate", "ultrathink")).toBe(
      "Ultrathink:\nInvestigate",
    );
    expect(isClaudeUltrathinkPrompt("Ultrathink:\nInvestigate")).toBe(true);
    expect(applyClaudePromptEffortPrefix("Ultrathink:\nInvestigate", "ultrathink")).toBe(
      "Ultrathink:\nInvestigate",
    );
  });
});
