/** IDs captured from the real `penkra models list` Claude catalog supplied for this regression. */
export const claudeModelsListFixture = [
  "claude-opus-5-5",
  "claude-sonnet-5",
  "claude-fable-5-1",
  "claude-haiku-4-5-20251001",
  "claude-opus-5",
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
] as const;
export const claudeDefaultModelId = "claude-opus-5-5";

/** Expected picker rows for the captured catalog, in source order. */
export const claudePickerModelsFixture = [
  { slug: "claude-opus-5-5", name: "Opus 5.5 (Default)", isDefault: true },
  { slug: "claude-sonnet-5", name: "Sonnet 5" },
  { slug: "claude-fable-5-1", name: "Fable 5.1" },
  { slug: "claude-haiku-4-5-20251001", name: "Haiku 4.5" },
] as const;
