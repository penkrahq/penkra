// FILE: composerDraftModels.ts
// Purpose: Normalizes three-provider model selections and resolves effective composer models.

import {
  ProviderKind,
  type ClaudeCodeEffort,
  type CodexReasoningEffort,
  type ModelSelection,
  type ModelSlug,
  type ProviderModelOptions,
} from "@penkra/contracts";
import * as Schema from "effect/Schema";
import {
  getDefaultModel,
  normalizeModelSlug,
  resolveModelSlugForProvider,
  resolveSelectableModel,
} from "@penkra/shared/model";

import { resolveAppModelSelection } from "./appSettings";
import type { ComposerThreadDraftState } from "./composerDraftDomain";
import { classifyProviderReasoningEffortSupport } from "./lib/codexReasoningEffort";

export const COMPOSER_PROVIDER_KINDS = [
  "codex",
  "claudeAgent",
  "opencode",
] as const satisfies readonly ProviderKind[];

const isProviderKind = Schema.is(ProviderKind);

export const LegacyCodexFields = Schema.Struct({
  effort: Schema.optionalKey(Schema.String),
  codexFastMode: Schema.optionalKey(Schema.Boolean),
  serviceTier: Schema.optionalKey(Schema.String),
});
export type LegacyCodexFields = typeof LegacyCodexFields.Type;

export interface EffectiveComposerModelState {
  selectedModel: ModelSlug;
  modelOptions: ProviderModelOptions | null;
}

function trimStringOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function objectValue(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const candidate = (value as Record<string, unknown>)[key];
  return candidate && typeof candidate === "object" ? (candidate as Record<string, unknown>) : null;
}

export function normalizeProviderKind(value: unknown): ProviderKind | null {
  return isProviderKind(value) ? value : null;
}

export function makeModelSelection(
  provider: ProviderKind,
  model: string,
  options?: ProviderModelOptions[ProviderKind],
): ModelSelection {
  return options
    ? ({ provider, model, options } as ModelSelection)
    : ({ provider, model } as ModelSelection);
}

export function normalizeProviderModelOptions(
  value: unknown,
  provider?: ProviderKind | null,
  legacy?: LegacyCodexFields,
): ProviderModelOptions | null {
  const codexCandidate = objectValue(value, "codex");
  const claudeCandidate = objectValue(value, "claudeAgent");
  const openCodeCandidate = objectValue(value, "opencode");

  const codexReasoningEffort: CodexReasoningEffort | undefined =
    trimStringOrUndefined(codexCandidate?.reasoningEffort) ??
    (provider === "codex" ? trimStringOrUndefined(legacy?.effort) : undefined);
  const codexFastMode =
    codexCandidate?.fastMode === true || codexCandidate?.fastMode === false
      ? codexCandidate.fastMode
      : provider === "codex" && (legacy?.codexFastMode === true || legacy?.serviceTier === "fast")
        ? true
        : undefined;
  const codex =
    codexReasoningEffort !== undefined || codexFastMode !== undefined
      ? {
          ...(codexReasoningEffort ? { reasoningEffort: codexReasoningEffort } : {}),
          ...(codexFastMode !== undefined ? { fastMode: codexFastMode } : {}),
        }
      : undefined;

  const claudeEffort: ClaudeCodeEffort | undefined = [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultrathink",
    "ultracode",
  ].includes(String(claudeCandidate?.effort))
    ? (claudeCandidate?.effort as ClaudeCodeEffort)
    : undefined;
  const claudeThinking =
    claudeCandidate?.thinking === true || claudeCandidate?.thinking === false
      ? claudeCandidate.thinking
      : undefined;
  const claudeFastMode =
    claudeCandidate?.fastMode === true || claudeCandidate?.fastMode === false
      ? claudeCandidate.fastMode
      : undefined;
  const autoCompactWindow =
    trimStringOrUndefined(claudeCandidate?.autoCompactWindow) ??
    trimStringOrUndefined(claudeCandidate?.contextWindow);
  const claudeAgent =
    claudeEffort !== undefined ||
    claudeThinking !== undefined ||
    claudeFastMode !== undefined ||
    autoCompactWindow !== undefined
      ? {
          ...(claudeEffort ? { effort: claudeEffort } : {}),
          ...(claudeThinking !== undefined ? { thinking: claudeThinking } : {}),
          ...(claudeFastMode !== undefined ? { fastMode: claudeFastMode } : {}),
          ...(autoCompactWindow ? { autoCompactWindow } : {}),
        }
      : undefined;

  const variant = trimStringOrUndefined(openCodeCandidate?.variant);
  const agent = trimStringOrUndefined(openCodeCandidate?.agent);
  const opencode =
    variant || agent ? { ...(variant ? { variant } : {}), ...(agent ? { agent } : {}) } : undefined;

  if (!codex && !claudeAgent && !opencode) return null;
  return {
    ...(codex ? { codex } : {}),
    ...(claudeAgent ? { claudeAgent } : {}),
    ...(opencode ? { opencode } : {}),
  };
}

export function normalizeModelSelection(
  value: unknown,
  legacy?: {
    provider?: unknown;
    model?: unknown;
    modelOptions?: unknown;
    legacyCodex?: LegacyCodexFields;
  },
): ModelSelection | null {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const provider = normalizeProviderKind(candidate?.provider ?? legacy?.provider);
  const rawModel = candidate?.model ?? legacy?.model;
  if (provider === null || typeof rawModel !== "string") return null;
  const inferredClaudeWindow =
    provider === "claudeAgent" && /\[1m\]$/iu.test(rawModel) ? "1m" : undefined;
  const model = normalizeModelSlug(rawModel, provider);
  if (!model) return null;
  const modelOptions = normalizeProviderModelOptions(
    candidate?.options ? { [provider]: candidate.options } : legacy?.modelOptions,
    provider,
    provider === "codex" ? legacy?.legacyCodex : undefined,
  );
  let options = modelOptions?.[provider];
  if (provider === "claudeAgent" && inferredClaudeWindow) {
    options = {
      ...modelOptions?.claudeAgent,
      autoCompactWindow: modelOptions?.claudeAgent?.autoCompactWindow ?? inferredClaudeWindow,
    };
  }
  return makeModelSelection(provider, model, options);
}

export function reconcileProviderScopedModelSelection(
  requested: ModelSelection,
  current: ModelSelection | null | undefined,
): ModelSelection {
  if (requested.options !== undefined || current?.provider !== requested.provider) return requested;
  if (current.model === requested.model) {
    return makeModelSelection(requested.provider, requested.model, current.options);
  }
  if (current.provider === "opencode") return requested;

  let preservedOptions = current.options;
  const effort =
    current.provider === "claudeAgent" ? current.options?.effort : current.options?.reasoningEffort;
  if (
    effort !== undefined &&
    classifyProviderReasoningEffortSupport({
      provider: requested.provider,
      model: requested.model,
      effort,
    }) !== "supported"
  ) {
    if (current.provider === "claudeAgent") {
      const { effort: _effort, ...rest } = current.options ?? {};
      preservedOptions = Object.keys(rest).length > 0 ? rest : undefined;
    } else {
      const { reasoningEffort: _effort, ...rest } = current.options ?? {};
      preservedOptions = Object.keys(rest).length > 0 ? rest : undefined;
    }
  }
  return makeModelSelection(requested.provider, requested.model, preservedOptions);
}

export function stripNonStickyModelOptions(selection: ModelSelection): ModelSelection {
  if (selection.provider !== "claudeAgent") return selection;
  const {
    contextWindow: _contextWindow,
    autoCompactWindow: _autoCompactWindow,
    ...rest
  } = selection.options ?? {};
  return makeModelSelection(
    selection.provider,
    selection.model,
    Object.keys(rest).length > 0 ? rest : undefined,
  );
}

export function sanitizeStickyModelSelectionMap(
  map: Partial<Record<ProviderKind, ModelSelection>>,
): Partial<Record<ProviderKind, ModelSelection>> {
  const claude = map.claudeAgent;
  return claude?.provider === "claudeAgent"
    ? { ...map, claudeAgent: stripNonStickyModelOptions(claude) }
    : map;
}

export function legacySyncModelSelectionOptions(
  modelSelection: ModelSelection | null,
  modelOptions: ProviderModelOptions | null | undefined,
): ModelSelection | null {
  return modelSelection
    ? makeModelSelection(
        modelSelection.provider,
        modelSelection.model,
        modelOptions?.[modelSelection.provider],
      )
    : null;
}

export function legacyMergeModelSelectionIntoProviderModelOptions(
  modelSelection: ModelSelection | null,
  currentModelOptions: ProviderModelOptions | null | undefined,
): ProviderModelOptions | null {
  const normalized = normalizeProviderModelOptions(currentModelOptions);
  if (!modelSelection?.options) return normalized;
  return normalizeProviderModelOptions({
    ...normalized,
    [modelSelection.provider]: modelSelection.options,
  });
}

export function legacyToModelSelectionByProvider(
  modelSelection: ModelSelection | null,
  modelOptions: ProviderModelOptions | null | undefined,
): Partial<Record<ProviderKind, ModelSelection>> {
  const result: Partial<Record<ProviderKind, ModelSelection>> = {};
  for (const provider of COMPOSER_PROVIDER_KINDS) {
    const options = modelOptions?.[provider];
    if (options && Object.keys(options).length > 0) {
      result[provider] = makeModelSelection(
        provider,
        modelSelection?.provider === provider ? modelSelection.model : getDefaultModel(provider),
        options,
      );
    }
  }
  if (modelSelection) result[modelSelection.provider] = modelSelection;
  return result;
}

function deriveEffectiveOptions(input: {
  draft:
    | Pick<ComposerThreadDraftState, "modelSelectionByProvider" | "activeProvider">
    | null
    | undefined;
  threadModelSelection: ModelSelection | null | undefined;
  projectModelSelection: ModelSelection | null | undefined;
}): ProviderModelOptions | null {
  const result: Partial<Record<ProviderKind, ProviderModelOptions[ProviderKind]>> = {};
  for (const selection of [
    input.projectModelSelection,
    input.threadModelSelection,
    ...Object.values(input.draft?.modelSelectionByProvider ?? {}),
  ]) {
    if (!selection) continue;
    if (selection.options) result[selection.provider] = selection.options;
    else delete result[selection.provider];
  }
  return Object.keys(result).length > 0 ? (result as ProviderModelOptions) : null;
}

export function deriveEffectiveComposerModelState(input: {
  draft:
    | Pick<ComposerThreadDraftState, "modelSelectionByProvider" | "activeProvider">
    | null
    | undefined;
  selectedProvider: ProviderKind;
  threadModelSelection: ModelSelection | null | undefined;
  projectModelSelection: ModelSelection | null | undefined;
  customModelsByProvider: Record<ProviderKind, readonly string[]>;
  availableModelOptionsByProvider?: Partial<
    Record<ProviderKind, ReadonlyArray<{ slug: string; name: string }>>
  >;
}): EffectiveComposerModelState {
  const availableOptions = input.availableModelOptionsByProvider?.[input.selectedProvider];
  const available = (candidate: string | null | undefined) =>
    availableOptions?.length
      ? resolveSelectableModel(input.selectedProvider, candidate, availableOptions)
      : null;
  const draftSelection = input.draft?.modelSelectionByProvider?.[input.selectedProvider];
  const threadSelection =
    input.threadModelSelection?.provider === input.selectedProvider
      ? input.threadModelSelection
      : null;
  const projectSelection =
    input.projectModelSelection?.provider === input.selectedProvider
      ? input.projectModelSelection
      : null;
  const selectedDraftModel = draftSelection?.model
    ? resolveAppModelSelection(
        input.selectedProvider,
        input.customModelsByProvider,
        draftSelection.model,
      )
    : null;
  const authoritativeCodex =
    input.selectedProvider === "codex" && Boolean(availableOptions?.length);
  const fallback = resolveModelSlugForProvider(
    input.selectedProvider,
    threadSelection?.model ?? projectSelection?.model ?? getDefaultModel(input.selectedProvider),
  );
  const selectedModel =
    available(draftSelection?.model) ??
    available(threadSelection?.model) ??
    available(projectSelection?.model) ??
    available(selectedDraftModel) ??
    (authoritativeCodex
      ? null
      : normalizeModelSlug(threadSelection?.model, input.selectedProvider)) ??
    (authoritativeCodex
      ? null
      : normalizeModelSlug(projectSelection?.model, input.selectedProvider)) ??
    availableOptions?.[0]?.slug ??
    selectedDraftModel ??
    fallback ??
    getDefaultModel("codex");
  return { selectedModel, modelOptions: deriveEffectiveOptions(input) };
}

export function resolvePreferredComposerModelSelection(input: {
  draft:
    | Pick<ComposerThreadDraftState, "modelSelectionByProvider" | "activeProvider">
    | null
    | undefined;
  threadModelSelection: ModelSelection | null | undefined;
  projectModelSelection: ModelSelection | null | undefined;
  defaultProvider?: ProviderKind | null | undefined;
}): ModelSelection {
  const draftProvider = COMPOSER_PROVIDER_KINDS.find(
    (provider) => input.draft?.modelSelectionByProvider?.[provider] !== undefined,
  );
  const provider =
    input.draft?.activeProvider ??
    draftProvider ??
    input.threadModelSelection?.provider ??
    input.projectModelSelection?.provider ??
    input.defaultProvider ??
    "codex";
  return (
    input.draft?.modelSelectionByProvider?.[provider] ??
    (input.threadModelSelection?.provider === provider ? input.threadModelSelection : null) ??
    (input.projectModelSelection?.provider === provider ? input.projectModelSelection : null) ?? {
      provider,
      model: getDefaultModel(provider),
    }
  );
}
