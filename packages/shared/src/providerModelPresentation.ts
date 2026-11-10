import type { ProviderKind, ProviderListModelsResult } from "@penkra/contracts";

/** Picker presentation only. Native selection validation keeps the full catalog. */
export function filterProviderModelsForPicker(
  provider: ProviderKind,
  catalog: ProviderListModelsResult,
): ProviderListModelsResult {
  if (provider === "opencode") {
    return { ...catalog, models: catalog.models.filter((model) => model.status !== "deprecated") };
  }
  if (provider === "codex") {
    return {
      ...catalog,
      models: catalog.models.filter(
        (model) => model.visibility !== "hide" && model.slug.toLowerCase() !== "codex-auto-review",
      ),
    };
  }
  return catalog;
}
