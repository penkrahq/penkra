// FILE: appOpenWithReconciler.ts
// Purpose: Selects deterministic App handlers while an Open With choice is System default.
// Layer: Trusted desktop App routing state

import type { AppInstallationState, InstalledAppPackage } from "./appInstallationState";
import { compareAppIntentCandidates } from "./appIntentRouter";
import type { AppOpenWithPreferenceStore } from "./appOpenWithPreferences";

type PreferenceWriter = Pick<AppOpenWithPreferenceStore, "setIfSystemDefault">;

interface HandlerCandidate {
  appId: string;
  slug: string;
}

export async function reconcileAppOpenWithPreferences(input: {
  state: AppInstallationState;
  openWith: PreferenceWriter;
}): Promise<void> {
  const enabledApps = listEnabledApps(input.state);
  const urlCandidates = collectCandidates(enabledApps, (app) =>
    (app.manifest.contributions?.handlers ?? []).some(
      (handler) =>
        handler.intent === "open-url" &&
        handler.schemes.some((scheme) => scheme === "http" || scheme === "https"),
    ),
  );
  if (urlCandidates[0]) {
    await input.openWith.setIfSystemDefault("open-url", urlCandidates[0].appId);
  }

  const directoryCandidates = collectCandidates(enabledApps, (app) =>
    (app.manifest.contributions?.handlers ?? []).some(
      (handler) => handler.intent === "open-directory",
    ),
  );
  if (directoryCandidates[0]) {
    await input.openWith.setIfSystemDefault("open-directory", directoryCandidates[0].appId);
  }

  const files = new Map<string, Map<string, HandlerCandidate>>();
  for (const app of enabledApps) {
    for (const handler of app.manifest.contributions?.handlers ?? []) {
      if (handler.intent !== "open-file") continue;
      for (const extension of handler.extensions) {
        const normalized = extension.toLowerCase();
        const candidates = files.get(normalized) ?? new Map<string, HandlerCandidate>();
        candidates.set(app.appId, { appId: app.appId, slug: app.slug });
        files.set(normalized, candidates);
      }
    }
  }
  for (const [extension, candidatesByAppId] of [...files.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const candidates = sortCandidates([...candidatesByAppId.values()]);
    if (candidates.length < 2) continue;
    await input.openWith.setIfSystemDefault("open-file", candidates[0]!.appId, extension);
  }
}

export function appOpenWithHandlerFingerprint(state: AppInstallationState): string {
  return listEnabledApps(state)
    .flatMap((app) =>
      (app.manifest.contributions?.handlers ?? []).map((handler) =>
        JSON.stringify([app.appId, app.slug, handler]),
      ),
    )
    .sort()
    .join("\n");
}

function listEnabledApps(state: AppInstallationState): InstalledAppPackage[] {
  return Object.entries(state.packagesByInstallationKey)
    .filter(([key]) => state.spaceStateByKey[key]?.enabled === true)
    .map(([, app]) => app);
}

function collectCandidates(
  apps: ReadonlyArray<InstalledAppPackage>,
  matches: (app: InstalledAppPackage) => boolean,
): HandlerCandidate[] {
  const byAppId = new Map<string, HandlerCandidate>();
  for (const app of apps) {
    if (matches(app)) byAppId.set(app.appId, { appId: app.appId, slug: app.slug });
  }
  return sortCandidates([...byAppId.values()]);
}

function sortCandidates(candidates: HandlerCandidate[]): HandlerCandidate[] {
  return candidates.sort(compareAppIntentCandidates);
}
