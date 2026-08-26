import {
  formatModelDisplayName,
  humanizeModelSlug,
  normalizeModelSlug,
} from "@penkra/shared/model";
import type {
  ClaudeModelOptions,
  ClaudeModelSelection,
  CodexModelOptions,
  CodexModelSelection,
  ModelSelection,
  OpenCodeModelOptions,
  OpenCodeModelSelection,
  ProviderKind,
  ProviderModelOptions,
} from "@penkra/contracts";

export type ProviderOptions = ProviderModelOptions[ProviderKind];

export interface ProviderModelOption {
  slug: string;
  name: string;
  description?: string;
  upstreamProviderId?: string;
  upstreamProviderName?: string;
}

export interface ProviderModelOptionGroup {
  key: string;
  label: string | null;
  options: ProviderModelOption[];
}

export function formatProviderModelOptionName(input: {
  provider: ProviderKind;
  slug: string;
}): string {
  const trimmedSlug = input.slug.trim();
  if (trimmedSlug.length === 0) {
    return trimmedSlug;
  }

  if (input.provider === "opencode") {
    const modelIdentifier = trimmedSlug.includes("/")
      ? trimmedSlug.slice(trimmedSlug.lastIndexOf("/") + 1)
      : trimmedSlug;
    return formatModelDisplayName(modelIdentifier) ?? humanizeModelSlug(modelIdentifier);
  }

  return formatModelDisplayName(trimmedSlug) ?? trimmedSlug;
}

function normalizeDynamicModelSlug(provider: ProviderKind, slug: string): string {
  if (provider === "claudeAgent") {
    // Claude runtime discovery already resolves evergreen selector aliases
    // (`opus`, `sonnet`) to canonical model ids. Never feed live identity back
    // through the static compatibility map, which may describe an older release.
    return slug.replace(/\[[^\]]+\]$/u, "").trim();
  }
  return normalizeModelSlug(slug, provider) ?? slug;
}

/**
 * Folds runtime-discovered models into the local option list for a provider.
 * Runtime descriptors own the identity and display name for every discovered
 * slug; user-defined custom models survive only when discovery does not contain
 * that slug. Codex discovery is account-aware, so its live list must not be
 * widened with models the signed-in account cannot use.
 */
export function mergeDynamicModelOptions(input: {
  provider: ProviderKind;
  staticOptions: ReadonlyArray<ProviderModelOption & { isCustom?: boolean }>;
  dynamicModels: ReadonlyArray<{
    slug: string;
    name?: string | null | undefined;
    description?: string | null | undefined;
    upstreamProviderId?: string | null | undefined;
    upstreamProviderName?: string | null | undefined;
  }>;
}): ReadonlyArray<ProviderModelOption & { isCustom?: boolean }> {
  const dynamicNormalizedSlugs = new Set<string>();
  const normalizedDynamicOptions: ProviderModelOption[] = [];

  for (const dynamicModel of input.dynamicModels) {
    const rawName = dynamicModel.name?.trim() ?? "";
    const isClaudeDefaultAlias =
      input.provider === "claudeAgent" &&
      (rawName.toLowerCase() === "default (recommended)" ||
        rawName.toLowerCase() === "default recommended" ||
        dynamicModel.slug.trim().toLowerCase() === "default");
    if (isClaudeDefaultAlias) {
      continue;
    }

    const normalizedSlug = normalizeDynamicModelSlug(input.provider, dynamicModel.slug);
    // Defense in depth for Codex runtime catalogs that omit the upstream
    // visibility marker on internal models.
    if (input.provider === "codex" && normalizedSlug.toLowerCase() === "codex-auto-review") {
      continue;
    }
    const rawSlug = dynamicModel.slug.trim().toLowerCase();
    const displayNameFallback = formatProviderModelOptionName({
      provider: input.provider,
      slug: normalizedSlug,
    });
    if (dynamicNormalizedSlugs.has(normalizedSlug)) {
      continue;
    }
    dynamicNormalizedSlugs.add(normalizedSlug);
    normalizedDynamicOptions.push({
      slug: normalizedSlug,
      name:
        rawName.length > 0 &&
        rawName.toLowerCase() !== rawSlug &&
        rawName.toLowerCase() !== normalizedSlug.toLowerCase()
          ? rawName
          : displayNameFallback,
      ...(dynamicModel.description?.trim() ? { description: dynamicModel.description.trim() } : {}),
      ...(dynamicModel.upstreamProviderId?.trim()
        ? { upstreamProviderId: dynamicModel.upstreamProviderId.trim() }
        : {}),
      ...(dynamicModel.upstreamProviderName?.trim()
        ? { upstreamProviderName: dynamicModel.upstreamProviderName.trim() }
        : {}),
    });
  }

  const customOnlyModels = input.staticOptions.filter(
    (model) =>
      "isCustom" in model &&
      model.isCustom &&
      !dynamicNormalizedSlugs.has(normalizeDynamicModelSlug(input.provider, model.slug)),
  );
  const staticBuiltInModels = input.staticOptions.filter(
    (model) => !("isCustom" in model) || model.isCustom !== true,
  );
  const missingStaticBuiltIns =
    normalizedDynamicOptions.length > 0
      ? []
      : staticBuiltInModels.filter((model) => !dynamicNormalizedSlugs.has(model.slug));

  const orderedDynamicOptions =
    input.provider === "claudeAgent"
      ? normalizedDynamicOptions.toReversed()
      : normalizedDynamicOptions;

  return [...orderedDynamicOptions, ...missingStaticBuiltIns, ...customOnlyModels];
}

/** Returns a compact label for provider descriptions that begin with an `Nx` cost multiplier. */
export function providerModelCostMultiplierLabel(description?: string): string | null {
  const multiplier = description?.trim().match(/^(\d+(?:\.\d+)?)x(?:\s|$)/i)?.[1];
  return multiplier ? `${multiplier}×` : null;
}

export function groupProviderModelOptions(
  options: ReadonlyArray<ProviderModelOption>,
): ProviderModelOptionGroup[] {
  const groupedOptions: ProviderModelOptionGroup[] = [];
  const groupIndexByKey = new Map<string, number>();

  for (const option of options) {
    const upstreamProviderId = option.upstreamProviderId?.trim();
    const upstreamProviderName = option.upstreamProviderName?.trim();
    const groupLabel =
      upstreamProviderName && upstreamProviderName.length > 0
        ? upstreamProviderName
        : upstreamProviderId && upstreamProviderId.length > 0
          ? upstreamProviderId
          : null;
    const groupKey = groupLabel
      ? `${(upstreamProviderId ?? groupLabel).trim().toLowerCase()}`
      : "__ungrouped__";
    const existingIndex = groupIndexByKey.get(groupKey);

    if (existingIndex !== undefined) {
      groupedOptions[existingIndex]!.options.push(option);
      continue;
    }

    groupIndexByKey.set(groupKey, groupedOptions.length);
    groupedOptions.push({
      key: groupKey,
      label: groupLabel,
      options: [option],
    });
  }

  return groupedOptions;
}

export function groupProviderModelOptionsWithFavorites(input: {
  options: ReadonlyArray<ProviderModelOption>;
  favoriteSlugs: ReadonlySet<string>;
  favoriteLabel?: string;
}): ProviderModelOptionGroup[] {
  if (input.favoriteSlugs.size === 0) {
    return groupProviderModelOptions(input.options);
  }

  const favoriteOptions = input.options.filter((option) => input.favoriteSlugs.has(option.slug));
  if (favoriteOptions.length === 0) {
    return groupProviderModelOptions(input.options);
  }
  const groupedOptions = groupProviderModelOptions(
    input.options.filter((option) => !input.favoriteSlugs.has(option.slug)),
  );

  return [
    {
      key: "__favorites__",
      label: input.favoriteLabel ?? "Favourites",
      options: favoriteOptions,
    },
    ...groupedOptions,
  ];
}

/** Long grouped model lists collapse provider sections to keep submenus scannable. */
export const COLLAPSIBLE_MODEL_GROUP_THRESHOLD = 3;

export function shouldUseCollapsibleModelGroups(groupCount: number, isSearching: boolean): boolean {
  return groupCount >= COLLAPSIBLE_MODEL_GROUP_THRESHOLD && !isSearching;
}

export function resolveModelGroupDefaultOpen(input: {
  groupKey: string;
  options: ReadonlyArray<ProviderModelOption>;
  activeModel: string;
  groupCount: number;
}): boolean {
  if (input.groupCount < COLLAPSIBLE_MODEL_GROUP_THRESHOLD) {
    return true;
  }
  if (input.groupKey === "__favorites__") {
    return true;
  }
  return input.options.some((option) => option.slug === input.activeModel);
}

export function buildNextProviderOptions(
  provider: ProviderKind,
  modelOptions: ProviderOptions | null | undefined,
  patch: Record<string, unknown>,
): ProviderOptions {
  if (provider === "codex") {
    return { ...(modelOptions as CodexModelOptions | undefined), ...patch } as CodexModelOptions;
  }
  if (provider === "claudeAgent") {
    return { ...(modelOptions as ClaudeModelOptions | undefined), ...patch } as ClaudeModelOptions;
  }
  return {
    ...(modelOptions as OpenCodeModelOptions | undefined),
    ...patch,
  } as OpenCodeModelOptions;
}

export function buildProviderOptionPatch(
  provider: ProviderKind,
  optionId: string,
  value: string | boolean,
): Record<string, unknown> {
  return { [optionId]: value };
}

export function buildModelSelection(
  provider: "codex",
  model: string,
  options?: CodexModelOptions | null | undefined,
): CodexModelSelection;
export function buildModelSelection(
  provider: "claudeAgent",
  model: string,
  options?: ClaudeModelOptions | null | undefined,
): ClaudeModelSelection;
export function buildModelSelection(
  provider: "opencode",
  model: string,
  options?: OpenCodeModelOptions | null | undefined,
): OpenCodeModelSelection;
export function buildModelSelection(
  provider: ProviderKind,
  model: string,
  options?: ProviderOptions | null | undefined,
): ModelSelection;
export function buildModelSelection(
  provider: ProviderKind,
  model: string,
  options?: ProviderOptions | null | undefined,
): ModelSelection {
  switch (provider) {
    case "codex":
      return options
        ? {
            provider,
            model,
            options: options as CodexModelOptions,
          }
        : { provider, model };
    case "claudeAgent":
      return options
        ? {
            provider,
            model,
            options: options as ClaudeModelOptions,
          }
        : { provider, model };
    case "opencode":
      return options
        ? {
            provider,
            model,
            options: options as OpenCodeModelOptions,
          }
        : { provider, model };
  }
}
