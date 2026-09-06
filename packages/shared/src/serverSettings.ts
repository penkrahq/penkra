import {
  type ModelSelection,
  type ProviderStartOptions,
  type ProviderKind,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@penkra/contracts";
import { deepMerge, type DeepPartial } from "./Struct";

function shouldReplaceTextGenerationModelSelection(
  patch: ServerSettingsPatch["textGenerationModelSelection"] | undefined,
): boolean {
  return Boolean(patch && (patch.provider !== undefined || patch.model !== undefined));
}

export function applyServerSettingsPatch(
  current: ServerSettings,
  patch: ServerSettingsPatch,
): ServerSettings {
  const selectionPatch = patch.textGenerationModelSelection;
  const providers = { ...patch.providers };
  for (const provider of Object.keys(providers) as ProviderKind[]) {
    const providerPatch = providers[provider];
    if (!providerPatch) continue;
    const { initializeDefaultConnectionId, ...updates } = providerPatch;
    providers[provider] = {
      ...updates,
      ...(initializeDefaultConnectionId !== undefined &&
      current.providers[provider].defaultConnectionId === undefined &&
      updates.defaultConnectionId === undefined
        ? { defaultConnectionId: initializeDefaultConnectionId }
        : {}),
    };
  }
  const next = deepMerge(current, { ...patch, providers } as DeepPartial<ServerSettings>);
  if (selectionPatch === undefined) {
    return next;
  }
  if (selectionPatch === null) {
    return { ...next, textGenerationModelSelection: null };
  }

  const currentSelection = current.textGenerationModelSelection;
  const provider = selectionPatch.provider ?? currentSelection?.provider;
  const model = selectionPatch.model ?? currentSelection?.model;
  if (
    !provider ||
    !model ||
    (selectionPatch.provider &&
      selectionPatch.provider !== currentSelection?.provider &&
      selectionPatch.model === undefined)
  ) {
    return { ...next, textGenerationModelSelection: null };
  }
  const options = shouldReplaceTextGenerationModelSelection(selectionPatch)
    ? selectionPatch.options
    : (selectionPatch.options ?? currentSelection?.options);

  return {
    ...next,
    textGenerationModelSelection: {
      provider,
      model,
      ...(options !== undefined ? { options } : {}),
    } as ModelSelection,
  };
}

/** Server-owned launch options derived from the persisted non-secret settings snapshot. */
export function providerStartOptionsFromServerSettings(
  settings: ServerSettings,
): ProviderStartOptions {
  const { providers } = settings;
  return {
    codex: {},
    claudeAgent: {},
    opencode: {
      experimentalWebSockets: providers.opencode.experimentalWebSockets,
    },
  };
}
