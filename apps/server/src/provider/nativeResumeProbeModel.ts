import type {
  ProviderConnectionId,
  ProviderKind,
  ProviderModelDescriptor,
} from "@penkra/contracts";

/** Ordered preferences for any verification that must send a model turn. */
export const NATIVE_RESUME_PROBE_MODEL_PREFERENCES = {
  claudeAgent: ["haiku", "sonnet"],
  codex: ["gpt-6-luna"],
  opencode: ["deepseek-v4.1-flash"],
} as const satisfies Record<ProviderKind, readonly string[]>;

function matchesPreference(provider: ProviderKind, slug: string, preference: string): boolean {
  const normalized = slug.toLowerCase();
  if (provider === "claudeAgent") {
    return normalized.split(/[^a-z0-9]+/u).includes(preference);
  }
  if (provider === "opencode") return normalized.endsWith(`/${preference}`);
  return normalized === preference;
}

/** Return an account-available test model; never substitute the thread model. */
export function selectNativeResumeProbeModel(input: {
  readonly provider: ProviderKind;
  readonly connectionId: ProviderConnectionId | null;
  readonly models: ReadonlyArray<ProviderModelDescriptor>;
  readonly selectedModelId?: string;
}): string | null {
  const available = (model: ProviderModelDescriptor) =>
    model.availableConnectionIds === undefined ||
    model.availableConnectionIds.includes(input.connectionId);
  for (const preference of NATIVE_RESUME_PROBE_MODEL_PREFERENCES[input.provider]) {
    const candidate = input.models.find(
      (model) => matchesPreference(input.provider, model.slug, preference) && available(model),
    );
    if (candidate) return candidate.slug;
  }
  return (
    input.models.find((model) => model.slug === input.selectedModelId && available(model))?.slug ??
    null
  );
}
