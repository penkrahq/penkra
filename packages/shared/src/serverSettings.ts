import {
  DEFAULT_MODEL_BY_PROVIDER,
  type ModelSelection,
  type ProviderStartOptions,
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
  const next = deepMerge(current, patch as DeepPartial<ServerSettings>);
  if (!selectionPatch) {
    return next;
  }

  const provider = selectionPatch.provider ?? current.textGenerationModelSelection.provider;
  const model =
    selectionPatch.model ??
    (selectionPatch.provider &&
    selectionPatch.provider !== current.textGenerationModelSelection.provider
      ? DEFAULT_MODEL_BY_PROVIDER[selectionPatch.provider]
      : current.textGenerationModelSelection.model);
  const options = shouldReplaceTextGenerationModelSelection(selectionPatch)
    ? selectionPatch.options
    : (selectionPatch.options ?? current.textGenerationModelSelection.options);

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
