// FILE: composerTraits.ts
// Purpose: Centralizes composer trait resolution so menu surfaces read the same model capability state.
// Layer: Chat composer state helpers
// Depends on: shared model capability helpers and provider model option types.

import {
  type ProviderOptionDescriptor,
  type ProviderKind,
  type ProviderModelDescriptor,
} from "@penkra/contracts";
import {
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  isClaudeUltrathinkPrompt,
  trimOrNull,
} from "@penkra/shared/model";

import type { ProviderOptions } from "../../providerModelOptions";
import { getRuntimeAwareModelCapabilities } from "./runtimeModelCapabilities";

function asSelectDescriptor(
  descriptor: ProviderOptionDescriptor | undefined,
): Extract<ProviderOptionDescriptor, { type: "select" }> | null {
  return descriptor?.type === "select" ? descriptor : null;
}

function asBooleanDescriptor(
  descriptor: ProviderOptionDescriptor | undefined,
): Extract<ProviderOptionDescriptor, { type: "boolean" }> | null {
  return descriptor?.type === "boolean" ? descriptor : null;
}

function primaryTraitSelectDescriptor(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): Extract<ProviderOptionDescriptor, { type: "select" }> | null {
  const descriptor = descriptors.find(
    (candidate): candidate is Extract<ProviderOptionDescriptor, { type: "select" }> =>
      candidate.type === "select" &&
      candidate.id !== "contextWindow" &&
      candidate.id !== "autoCompactWindow",
  );
  return descriptor && descriptor.options.length > 1 ? descriptor : null;
}

function selectOptions(descriptor: Extract<ProviderOptionDescriptor, { type: "select" }> | null) {
  return (
    descriptor?.options.map((option) => ({
      value: option.id,
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
      ...(option.isDefault ? { isDefault: true as const } : {}),
    })) ?? []
  );
}

// Merges legacy capability flags with descriptor-specific prompt injection hints.
function promptInjectedValuesForDescriptor(
  capsPromptInjectedValues: ReadonlyArray<string>,
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }> | null,
) {
  return Array.from(
    new Set([...capsPromptInjectedValues, ...(descriptor?.promptInjectedValues ?? [])]),
  );
}

// Resolve the currently selected composer traits from capabilities plus draft overrides.
export function getComposerTraitSelection(
  provider: ProviderKind,
  model: string | null | undefined,
  prompt: string,
  modelOptions: ProviderOptions | null | undefined,
  runtimeModel?: ProviderModelDescriptor,
) {
  const caps = getRuntimeAwareModelCapabilities({ provider, model, runtimeModel });
  const descriptors = getProviderOptionDescriptors({
    provider,
    caps,
    selections: modelOptions as Record<string, unknown> | undefined,
  });
  const primarySelectDescriptor = primaryTraitSelectDescriptor(descriptors);
  const contextWindowDescriptor = asSelectDescriptor(
    descriptors.find((descriptor) => descriptor.id === "autoCompactWindow") ??
      descriptors.find((descriptor) => descriptor.id === "contextWindow"),
  );
  const fastModeDescriptor = asBooleanDescriptor(
    descriptors.find((descriptor) => descriptor.id === "fastMode"),
  );
  const thinkingDescriptor = asBooleanDescriptor(
    descriptors.find((descriptor) => descriptor.id === "thinking"),
  );
  const effortLevels = selectOptions(primarySelectDescriptor);
  const contextWindowOptions = selectOptions(contextWindowDescriptor);
  const defaultEffort =
    primarySelectDescriptor?.options.find((option) => option.isDefault)?.id ??
    primarySelectDescriptor?.options[0]?.id ??
    null;
  const defaultContextWindow =
    contextWindowDescriptor?.options.find((option) => option.isDefault)?.id ??
    contextWindowDescriptor?.options[0]?.id ??
    null;
  const resolvedEffort = trimOrNull(
    getProviderOptionCurrentValue(primarySelectDescriptor) as string | undefined,
  );
  const resolvedContextWindow = trimOrNull(
    getProviderOptionCurrentValue(contextWindowDescriptor) as string | undefined,
  );
  const promptInjectedValues = promptInjectedValuesForDescriptor(
    caps.promptInjectedEffortLevels,
    primarySelectDescriptor,
  );
  const isPromptInjected = resolvedEffort ? promptInjectedValues.includes(resolvedEffort) : false;
  const effort = resolvedEffort && !isPromptInjected ? resolvedEffort : defaultEffort;

  const thinkingEnabled = thinkingDescriptor ? (thinkingDescriptor.currentValue ?? true) : null;

  const fastModeEnabled =
    Boolean(fastModeDescriptor) && (fastModeDescriptor?.currentValue ?? false) === true;

  const contextWindow = resolvedContextWindow ?? defaultContextWindow;

  const ultrathinkPromptControlled =
    promptInjectedValues.length > 0 && isClaudeUltrathinkPrompt(prompt);

  return {
    caps,
    descriptors,
    primarySelectDescriptor,
    fastModeDescriptor,
    thinkingDescriptor,
    contextWindowDescriptor,
    promptInjectedValues,
    defaultEffort,
    effort,
    effortLevels,
    thinkingEnabled,
    fastModeEnabled,
    contextWindowOptions,
    contextWindow,
    defaultContextWindow,
    ultrathinkPromptControlled,
  };
}

export function hasVisibleComposerTraitControls(
  selection: Pick<
    ReturnType<typeof getComposerTraitSelection>,
    "caps" | "effortLevels" | "thinkingEnabled" | "contextWindowOptions" | "fastModeDescriptor"
  >,
  options?: {
    includeFastMode?: boolean;
  },
): boolean {
  return (
    selection.effortLevels.length > 0 ||
    selection.thinkingEnabled !== null ||
    selection.contextWindowOptions.length > 1 ||
    ((options?.includeFastMode ?? true) &&
      (selection.fastModeDescriptor !== null || selection.caps.supportsFastMode))
  );
}
