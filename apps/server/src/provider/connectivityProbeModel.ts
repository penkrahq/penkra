import type { ProviderConnectionId, ProviderModelDescriptor } from "@penkra/contracts";

export interface ConnectivityProbeModel {
  readonly model: string;
  readonly effort?: string;
}

// These are model tiers, not model IDs. Unknown and specialized models are
// deliberately ineligible: a connectivity check must not fall back to a large
// or expensive default model when discovery changes.
const LIGHT_TIER_RANK = new Map([
  ["nano", 0],
  ["flash", 1],
  ["haiku", 2],
  ["luna", 3],
  ["mini", 4],
  ["lite", 5],
  ["small", 6],
  ["instant", 7],
]);
const EFFORT_RANK = new Map([
  ["none", 0],
  ["minimal", 1],
  ["low", 2],
  ["medium", 3],
  ["high", 4],
  ["xhigh", 5],
  ["max", 6],
]);
const SPECIALIZED_TOKENS = new Set(["vision", "image", "audio", "video", "preview", "exp"]);

function tokens(value: string): ReadonlyArray<string> {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

function lowestEffort(model: ProviderModelDescriptor): string | undefined {
  return model.supportedReasoningEfforts
    ?.map((option) => option.value)
    .filter((value) => EFFORT_RANK.has(value.toLowerCase()))
    .toSorted(
      (left, right) =>
        (EFFORT_RANK.get(left.toLowerCase()) ?? Infinity) -
          (EFFORT_RANK.get(right.toLowerCase()) ?? Infinity) || left.localeCompare(right),
    )[0];
}

/** Pick the weakest recognized general-purpose tier in this exact Connection's catalog. */
export function selectConnectivityProbeModel(input: {
  readonly models: ReadonlyArray<ProviderModelDescriptor>;
  readonly connectionId: ProviderConnectionId;
}): ConnectivityProbeModel | null {
  const eligible = input.models.flatMap((descriptor) => {
    if (
      descriptor.availableConnectionIds &&
      !descriptor.availableConnectionIds.includes(input.connectionId)
    ) {
      return [];
    }
    const modelTokens = tokens(`${descriptor.slug} ${descriptor.name}`);
    if (modelTokens.some((token) => SPECIALIZED_TOKENS.has(token))) return [];
    const rank = Math.min(...modelTokens.map((token) => LIGHT_TIER_RANK.get(token) ?? Infinity));
    if (!Number.isFinite(rank)) return [];
    return [{ descriptor, rank }];
  });
  const choice = eligible.toSorted(
    (left, right) =>
      left.rank - right.rank || left.descriptor.slug.localeCompare(right.descriptor.slug),
  )[0]?.descriptor;
  if (!choice) return null;
  const effort = lowestEffort(choice);
  return { model: choice.slug, ...(effort ? { effort } : {}) };
}
