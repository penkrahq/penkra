// FILE: appFileIntentResolver.ts
// Purpose: Resolves existing files and directories through exact declared App handlers.
// Layer: Trusted desktop App routing boundary

import * as Path from "node:path";

import type { AppIntentRouter, ResolvedAppIntent } from "./appIntentRouter";
import type { AppOpenWithPreferenceStore } from "./appOpenWithPreferences";

export function resolvePathIntent(input: {
  intents: AppIntentRouter;
  kind: "directory" | "file";
  openWith: AppOpenWithPreferenceStore;
  path: string;
  requestedApp?: string;
  spaceId: string;
}): ResolvedAppIntent | null {
  if (input.kind === "directory") {
    const preferredAppId = input.openWith.get(input.spaceId, "open-directory");
    return input.intents.resolve(input.spaceId, {
      intent: "open-directory",
      ...(input.requestedApp ? { requestedApp: input.requestedApp } : {}),
      ...(preferredAppId ? { preferredAppId } : {}),
    });
  }

  const extension = Path.extname(input.path).toLowerCase();
  const preferredAppId = input.openWith.get(input.spaceId, "open-file", extension);
  return input.intents.resolve(input.spaceId, {
    intent: "open-file",
    extension,
    ...(input.requestedApp ? { requestedApp: input.requestedApp } : {}),
    ...(preferredAppId ? { preferredAppId } : {}),
  });
}
