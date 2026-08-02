// FILE: appIntentRouter.ts
// Purpose: Resolves explicit URL/file intents against enabled App handler contributions.
// Layer: Trusted desktop App routing boundary

import type { AppHandlerDeclaration } from "@penkra/sdk";

import type { AppInstallationState, InstalledAppPackage } from "./appInstallationState";

export type AppIntentRequest =
  | { intent: "open-url"; url: string; preferredAppId?: string }
  | { intent: "open-file"; mediaType?: string; extension?: string; preferredAppId?: string };

export interface ResolvedAppIntent {
  appId: string;
  slug: string;
  name: string;
  operation: string;
}

export class AppIntentRouterError extends Error {
  constructor(
    readonly code:
      | "handler-choice-required"
      | "handler-not-found"
      | "preferred-handler-unavailable",
    message: string,
    readonly candidates: ReadonlyArray<ResolvedAppIntent> = [],
  ) {
    super(message);
    this.name = "AppIntentRouterError";
  }
}

export class AppIntentRouter {
  constructor(readonly installationState: () => AppInstallationState) {}

  resolve(spaceId: string, request: AppIntentRequest): ResolvedAppIntent {
    const state = this.installationState();
    const candidates = Object.values(state.packagesByAppId)
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
    if (request.preferredAppId) {
      const preferred = candidates.find((candidate) => candidate.appId === request.preferredAppId);
      if (!preferred) {
        throw new AppIntentRouterError(
          "preferred-handler-unavailable",
          `The preferred App cannot handle ${request.intent} in Space ${spaceId}.`,
          candidates,
        );
      }
      return preferred;
    }
    if (candidates.length === 0) {
      throw new AppIntentRouterError(
        "handler-not-found",
        `No enabled App can handle ${request.intent} in Space ${spaceId}.`,
      );
    }
    if (candidates.length > 1) {
      throw new AppIntentRouterError(
        "handler-choice-required",
        `Choose an App to handle ${request.intent}.`,
        candidates,
      );
    }
    return candidates[0]!;
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
      const mediaType = request.mediaType?.toLowerCase();
      const extension = request.extension?.toLowerCase();
      return (
        (mediaType !== undefined &&
          handler.mediaTypes?.some((value) => value.toLowerCase() === mediaType)) ||
        (extension !== undefined &&
          handler.extensions?.some((value) => value.toLowerCase() === extension))
      );
    }
    return false;
  });
}

function isEnabled(state: AppInstallationState, appId: string, spaceId: string): boolean {
  return Object.values(state.spaceStateByKey).some(
    (space) => space.appId === appId && space.spaceId === spaceId && space.enabled,
  );
}
