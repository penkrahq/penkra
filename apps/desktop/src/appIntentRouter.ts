// FILE: appIntentRouter.ts
// Purpose: Resolves explicit URL/file intents against enabled App handler contributions.
// Layer: Trusted desktop App routing boundary

import type { AppHandlerDeclaration } from "@penkra/sdk";

import {
  listInstalledAppsForSpace,
  type AppInstallationState,
  type InstalledAppPackage,
} from "./appInstallationState";

export type AppIntentRequest =
  | { intent: "open-url"; url: string; requestedApp?: string; preferredAppId?: string }
  | { intent: "open-file"; extension: string; requestedApp?: string; preferredAppId?: string }
  | { intent: "open-directory"; requestedApp?: string; preferredAppId?: string };

export interface ResolvedAppIntent {
  appId: string;
  slug: string;
  name: string;
  operation: string;
}

export class AppIntentRouterError extends Error {
  constructor(
    readonly code: "handler-not-found" | "requested-handler-unavailable",
    message: string,
    readonly candidates: ReadonlyArray<ResolvedAppIntent> = [],
  ) {
    super(message);
    this.name = "AppIntentRouterError";
  }
}

export class AppIntentRouter {
  constructor(readonly installationState: () => AppInstallationState) {}

  candidates(spaceId: string, request: AppIntentRequest): ResolvedAppIntent[] {
    const state = this.installationState();
    return listInstalledAppsForSpace(state, spaceId)
      .filter((app) => isEnabled(state, app.appId, spaceId))
      .flatMap((app) =>
        matchingHandlers(app, request).map((handler) => ({
          appId: app.appId,
          slug: app.slug,
          name: app.name,
          operation: handler.operation,
        })),
      )
      .sort((left, right) => left.slug.localeCompare(right.slug));
  }

  resolve(spaceId: string, request: AppIntentRequest): ResolvedAppIntent | null {
    const candidates = this.candidates(spaceId, request);
    if (request.requestedApp) {
      const requested = candidates.find(
        (candidate) =>
          candidate.appId === request.requestedApp || candidate.slug === request.requestedApp,
      );
      if (!requested) {
        throw new AppIntentRouterError(
          "requested-handler-unavailable",
          `The requested App cannot handle ${request.intent} in Space ${spaceId}.`,
          candidates,
        );
      }
      return requested;
    }
    if (request.preferredAppId) {
      const preferred = candidates.find((candidate) => candidate.appId === request.preferredAppId);
      if (preferred) return preferred;
    }
    if (request.intent === "open-file" && candidates.length === 1) return candidates[0]!;
    return null;
  }
}

function matchingHandlers(
  app: InstalledAppPackage,
  request: AppIntentRequest,
): AppHandlerDeclaration[] {
  return (app.manifest.contributions?.handlers ?? []).filter((handler) => {
    if (handler.intent !== request.intent) return false;
    if (handler.intent === "open-url" && request.intent === "open-url") {
      let scheme: string;
      try {
        scheme = new URL(request.url).protocol.slice(0, -1).toLowerCase();
      } catch {
        throw new AppIntentRouterError(
          "handler-not-found",
          "The URL intent contains an invalid URL.",
        );
      }
      return handler.schemes.includes(scheme);
    }
    if (handler.intent === "open-file" && request.intent === "open-file") {
      const extension = request.extension.toLowerCase();
      return handler.extensions.some((value) => value.toLowerCase() === extension);
    }
    if (handler.intent === "open-directory" && request.intent === "open-directory") return true;
    return false;
  });
}

function isEnabled(state: AppInstallationState, appId: string, spaceId: string): boolean {
  return Object.values(state.spaceStateByKey).some(
    (space) => space.appId === appId && space.spaceId === spaceId && space.enabled,
  );
}
