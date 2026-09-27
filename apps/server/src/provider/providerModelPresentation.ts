import type { ProviderKind, ProviderListModelsResult } from "@penkra/contracts";

type ClaudeVersion = { family: string; major: number; minor: number };

/** Parse the two documented Claude model ID conventions; opaque IDs deliberately fail open. */
function parseClaudeVersion(slug: string): ClaudeVersion | undefined {
  let id = slug.toLowerCase();
  id = id.replace(/\[1m\]$/, "").replace(/-\d{8}$/, "");
  const familyFirst = /^claude-([a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*)-(\d+)(?:-(\d+))?$/.exec(id);
  if (familyFirst) {
    return {
      family: familyFirst[1]!,
      major: Number(familyFirst[2]),
      minor: Number(familyFirst[3] ?? 0),
    };
  }
  const versionFirst = /^claude-(\d+)(?:-(\d+))?-([a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*)$/.exec(id);
  if (versionFirst) {
    return {
      family: versionFirst[3]!,
      major: Number(versionFirst[1]),
      minor: Number(versionFirst[2] ?? 0),
    };
  }
  return undefined;
}

function compareClaudeVersions(left: ClaudeVersion, right: ClaudeVersion): number {
  return left.major - right.major || left.minor - right.minor;
}

function currentClaudeModels(
  models: ProviderListModelsResult["models"],
): ProviderListModelsResult["models"] {
  const latestByFamily = new Map<string, ClaudeVersion>();
  for (const model of models) {
    const parsed = parseClaudeVersion(model.slug);
    if (!parsed) continue;
    const latest = latestByFamily.get(parsed.family);
    if (!latest || compareClaudeVersions(parsed, latest) > 0)
      latestByFamily.set(parsed.family, parsed);
  }
  return models.filter((model) => {
    if (model.isDefault) return true;
    const parsed = parseClaudeVersion(model.slug);
    if (!parsed) return true;
    return compareClaudeVersions(parsed, latestByFamily.get(parsed.family)!) === 0;
  });
}

/** Provider metadata is filtered here for picker display only. Validation keeps the source catalog. */
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
  if (provider === "claudeAgent") {
    return { ...catalog, models: currentClaudeModels(catalog.models) };
  }
  return catalog;
}
